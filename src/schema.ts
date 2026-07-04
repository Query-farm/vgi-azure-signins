// Arrow output schemas + row→batch mapping for the two audit collections.
// One EndpointSpec drives everything (schema, endpoint, business columns), so
// signin_logs / audit_logs are data, not duplicated code — the same shape the
// directory template uses for users/groups/devices.
//
// Marker contract (graph-core-SPEC decision D): data rows have `_row_kind` NULL;
// exactly ONE marker row (`_row_kind='marker'`, `_watermark_next`=ISO watermark,
// ALL business columns null) carries the cursor. Consumers read data via
// `WHERE _row_kind IS NULL` and the cursor off the single marker row.
//
// PII DOCTRINE (SPEC §4.1, graph-core-SPEC decision H): `ip_address` and
// `user_principal_name` are PII-bearing and MUST be published through the mandatory
// vgi-pii -> vgi-mask composition (format-preserving encryption) so masked values
// STAY JOINABLE across tables (a masked UPN still joins vgi-azure-directory; a masked
// IP still groups). The mask composition is the default surface; projecting any
// unpromoted raw JSON re-widens the PII surface and must be opt-in.

import { Schema, Field, Utf8 } from "@query-farm/apache-arrow";
import { batchFromColumns } from "@query-farm/vgi";
import { ROW_KIND, MARKER, WATERMARK_NEXT } from "@vgi-azure/graph-core";
import type { Endpoint } from "./watermark-driver.js";

export interface BusinessCol {
  /** SQL column name. */ col: string;
  /** Dotted path into the raw Graph object (e.g. "status.errorCode"). */ path: string;
  /** vgi-pii -> vgi-mask (FPE) composition applies to this column (SPEC §4.1). */ pii?: boolean;
}

export interface EndpointSpec {
  fn: string;
  endpoint: Endpoint;
  description: string;
  business: BusinessCol[];
}

// signin_logs — GET /auditLogs/signIns (Entra ID P1/P2 gated).
export const SIGNINS: EndpointSpec = {
  fn: "signin_logs",
  endpoint: "signIns",
  description:
    "Entra ID sign-in logs via Microsoft Graph (lagged-watermark on createdDateTime; at-least-once + dedup-by-id).",
  business: [
    { col: "created_date_time", path: "createdDateTime" },
    { col: "app_display_name", path: "appDisplayName" },
    { col: "user_principal_name", path: "userPrincipalName", pii: true },
    { col: "ip_address", path: "ipAddress", pii: true },
    { col: "status", path: "status.errorCode" },
  ],
};

// audit_logs — GET /auditLogs/directoryAudits (available more broadly than signIns).
export const AUDITS: EndpointSpec = {
  fn: "audit_logs",
  endpoint: "directoryAudits",
  description:
    "Entra ID directory audit logs via Microsoft Graph (lagged-watermark on createdDateTime; at-least-once + dedup-by-id).",
  business: [
    { col: "created_date_time", path: "createdDateTime" },
    { col: "app_display_name", path: "loggedByService" },
    { col: "user_principal_name", path: "initiatedBy.user.userPrincipalName", pii: true },
    { col: "ip_address", path: "initiatedBy.user.ipAddress", pii: true },
    { col: "status", path: "result" },
  ],
};

export const SPECS: readonly EndpointSpec[] = [SIGNINS, AUDITS];

export function schemaFor(spec: EndpointSpec): Schema {
  return new Schema([
    new Field("id", new Utf8(), true),
    ...spec.business.map((b) => new Field(b.col, new Utf8(), true)),
    new Field(ROW_KIND, new Utf8(), true),
    new Field(WATERMARK_NEXT, new Utf8(), true),
  ]);
}

/** Read a dotted path (e.g. "status.errorCode") out of a raw Graph object. */
function pick(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Build one Arrow batch: the business rows (`_row_kind` null) followed by exactly
 * ONE strict marker row (all business columns null, `_row_kind='marker'`,
 * `_watermark_next` = the ISO watermark). Emitting N+1 rows in one batch keeps the
 * marker atomic with its data (graph-core §D). `watermarkNext===null` means "no
 * marker this emission" — used while paging so only the FINAL emission stamps the
 * cursor.
 */
export function buildWatermarkBatch(
  spec: EndpointSpec,
  schema: Schema,
  rows: Record<string, unknown>[],
  watermarkNext: string | null,
) {
  const cols: Record<string, unknown[]> = { id: [], [ROW_KIND]: [], [WATERMARK_NEXT]: [] };
  for (const b of spec.business) cols[b.col] = [];

  for (const r of rows) {
    cols.id!.push(r.id == null ? null : String(r.id));
    for (const b of spec.business) {
      const v = pick(r, b.path);
      cols[b.col]!.push(v == null ? null : String(v));
    }
    cols[ROW_KIND]!.push(null);
    cols[WATERMARK_NEXT]!.push(null);
  }

  if (watermarkNext !== null) {
    // The single strict marker row: all business columns null, cursor set.
    cols.id!.push(null);
    for (const b of spec.business) cols[b.col]!.push(null);
    cols[ROW_KIND]!.push(MARKER);
    cols[WATERMARK_NEXT]!.push(watermarkNext);
  }

  return batchFromColumns(cols as Record<string, unknown[]>, schema);
}
