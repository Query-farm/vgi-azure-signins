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

export interface FnExample {
  sql: string;
  description: string;
}

/** One entry of a static vgi.result_columns_schema — {name, type, description}. */
export interface ResultColumn {
  name: string;
  /** A real DuckDB type (VARCHAR / BOOLEAN / …). */ type: string;
  description: string;
}

export interface EndpointSpec {
  fn: string;
  endpoint: Endpoint;
  description: string;
  business: BusinessCol[];
  /** vgi.title — human display name (multi-word so it doesn't equal the machine name). */
  title: string;
  /** vgi.keywords — search terms / synonyms. */
  keywords: string[];
  /** vgi.doc_llm — LLM-oriented "what is it / when to use it" prose. */
  docLlm: string;
  /** vgi.doc_md — richer human Markdown narrative. */
  docMd: string;
  /** vgi.result_columns_schema — the static result columns as {name,type,description}. */
  resultColumns: ResultColumn[];
  /** Per-function examples surfaced via the function descriptor. */
  examples: FnExample[];
}

// The id, control (`_row_kind`) and cursor (`_watermark_next`) columns are common to
// both endpoints' output; only the five business columns in the middle differ in what
// they source. This shared head/tail keeps every result_columns_schema aligned with
// schemaFor()'s field order.
const RESULT_COLUMNS_HEAD: ResultColumn[] = [
  {
    name: "id",
    type: "VARCHAR",
    description:
      "The Graph event's unique id (used for idempotent dedup-by-id on apply). NULL on the marker row.",
  },
];
const RESULT_COLUMNS_TAIL: ResultColumn[] = [
  {
    name: "_row_kind",
    type: "VARCHAR",
    description: "NULL for data rows; 'marker' for the single trailing cursor row.",
  },
  {
    name: "_watermark_next",
    type: "VARCHAR",
    description:
      "On the marker row, the ISO-8601 (already lag-adjusted) high-watermark to persist and replay via the `since` argument on the next scan; NULL on data rows.",
  },
];

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
  title: "Entra Sign-in Logs Feed",
  keywords: [
    "entra id",
    "azure ad",
    "sign-in",
    "signin",
    "logins",
    "authentication",
    "auditlogs",
    "watermark",
    "incremental",
    "security",
    "identity",
  ],
  docLlm:
    "Incremental feed of Microsoft Entra ID (Azure AD) sign-in logs via Microsoft Graph " +
    "(GET /auditLogs/signIns). Each scan returns interactive user sign-in events whose " +
    "createdDateTime falls in the requested window, followed by a marker row whose " +
    "_watermark_next is the (already lag-adjusted) high-watermark to persist. Pass that value " +
    "back as `since` for the next scan; omit `since` for a backfill from the start of retention. " +
    "The 'ge' + safety-lag overlap re-emits the window tail every scan, so apply must be " +
    "idempotent dedup-by-id. Columns: created_date_time, app_display_name, user_principal_name, " +
    "ip_address, and status (the sign-in errorCode; 0 = success). Requires an app-only " +
    "'azure_graph' secret; reading /auditLogs/signIns requires Entra ID P1/P2 and " +
    "AuditLog.Read.All. ip_address and user_principal_name are published through the mandatory " +
    "vgi-pii -> vgi-mask (format-preserving) composition so masked values stay joinable.",
  docMd:
    "## signin_logs\n\n" +
    "Microsoft Entra ID sign-in logs as an incremental feed backed by Microsoft Graph's " +
    "`/auditLogs/signIns` endpoint, cursored by a lagged high-watermark on `createdDateTime`. " +
    "Read data rows with `WHERE _row_kind IS NULL`; take the next cursor from the marker row's " +
    "`_watermark_next` and feed it back as `since`. Apply idempotently (dedup-by-id) because the " +
    "safety-lag overlap re-emits the window tail. See the examples for full, runnable queries.\n\n" +
    "> Reading sign-in logs requires Entra ID P1/P2 and the `AuditLog.Read.All` Graph permission. " +
    "`ip_address` and `user_principal_name` are PII published through the mandatory " +
    "vgi-pii -> vgi-mask composition.",
  resultColumns: [
    ...RESULT_COLUMNS_HEAD,
    {
      name: "created_date_time",
      type: "VARCHAR",
      description: "ISO-8601 timestamp the sign-in occurred (`createdDateTime`).",
    },
    {
      name: "app_display_name",
      type: "VARCHAR",
      description: "Display name of the application the user signed in to (`appDisplayName`).",
    },
    {
      name: "user_principal_name",
      type: "VARCHAR",
      description:
        "UPN of the signing-in user (`userPrincipalName`). PII — published through the vgi-pii -> vgi-mask (format-preserving) composition.",
    },
    {
      name: "ip_address",
      type: "VARCHAR",
      description:
        "Source IP address of the sign-in (`ipAddress`). PII — published through the vgi-pii -> vgi-mask (format-preserving) composition.",
    },
    {
      name: "status",
      type: "VARCHAR",
      description: "The sign-in status error code (`status.errorCode`); '0' denotes a successful sign-in.",
    },
    ...RESULT_COLUMNS_TAIL,
  ],
  examples: [
    {
      sql: "SELECT id, created_date_time, app_display_name, user_principal_name, status FROM azure.main.signin_logs() WHERE _row_kind IS NULL",
      description: "Backfill all available sign-in events (data rows only)",
    },
    {
      sql: "SELECT id, created_date_time, app_display_name FROM azure.main.signin_logs(since := '<prior _watermark_next>') WHERE _row_kind IS NULL",
      description: "Incremental scan replaying a previously saved high-watermark cursor",
    },
    {
      sql: "SELECT app_display_name, count(*) AS failures FROM azure.main.signin_logs() WHERE _row_kind IS NULL AND status <> '0' GROUP BY app_display_name ORDER BY failures DESC",
      description: "Count failed sign-ins per application (non-zero errorCode)",
    },
    {
      sql: "SELECT _watermark_next FROM azure.main.signin_logs() WHERE _row_kind = 'marker'",
      description: "Read the high-watermark cursor to persist for the next scan",
    },
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
  title: "Entra Directory Audit Logs Feed",
  keywords: [
    "entra id",
    "azure ad",
    "audit",
    "directory audits",
    "activity",
    "change log",
    "auditlogs",
    "watermark",
    "incremental",
    "security",
    "identity",
  ],
  docLlm:
    "Incremental feed of Microsoft Entra ID (Azure AD) directory audit logs via Microsoft Graph " +
    "(GET /auditLogs/directoryAudits). Each scan returns directory activity/change events whose " +
    "createdDateTime falls in the requested window, followed by a marker row whose _watermark_next " +
    "is the (already lag-adjusted) high-watermark to persist. Pass that value back as `since` for " +
    "the next scan; omit `since` for a backfill from the start of retention. The 'ge' + safety-lag " +
    "overlap re-emits the window tail every scan, so apply must be idempotent dedup-by-id. Directory " +
    "audit logs are available more broadly than sign-in logs (no Entra ID P1/P2 requirement). " +
    "Columns: created_date_time, app_display_name (the logging service), user_principal_name and " +
    "ip_address of the initiating user, and status (the audit result, e.g. success/failure). Requires " +
    "an app-only 'azure_graph' secret with AuditLog.Read.All. ip_address and user_principal_name are " +
    "published through the mandatory vgi-pii -> vgi-mask (format-preserving) composition so masked " +
    "values stay joinable.",
  docMd:
    "## audit_logs\n\n" +
    "Microsoft Entra ID directory audit logs as an incremental feed backed by Microsoft Graph's " +
    "`/auditLogs/directoryAudits` endpoint, cursored by a lagged high-watermark on `createdDateTime`. " +
    "Read data rows with `WHERE _row_kind IS NULL`; take the next cursor from the marker row's " +
    "`_watermark_next` and feed it back as `since`. Apply idempotently (dedup-by-id) because the " +
    "safety-lag overlap re-emits the window tail. See the examples for full, runnable queries.\n\n" +
    "> Directory audit logs are available more broadly than sign-in logs; reading them requires the " +
    "`AuditLog.Read.All` Graph permission. `ip_address` and `user_principal_name` are PII published " +
    "through the mandatory vgi-pii -> vgi-mask composition.",
  resultColumns: [
    ...RESULT_COLUMNS_HEAD,
    {
      name: "created_date_time",
      type: "VARCHAR",
      description: "ISO-8601 timestamp the audit event was logged (`createdDateTime`).",
    },
    {
      name: "app_display_name",
      type: "VARCHAR",
      description:
        "The Entra service that logged the event (`loggedByService`, e.g. Core Directory, Self-service Password Management).",
    },
    {
      name: "user_principal_name",
      type: "VARCHAR",
      description:
        "UPN of the user who initiated the activity (`initiatedBy.user.userPrincipalName`). PII — published through the vgi-pii -> vgi-mask (format-preserving) composition.",
    },
    {
      name: "ip_address",
      type: "VARCHAR",
      description:
        "IP address of the initiating user (`initiatedBy.user.ipAddress`). PII — published through the vgi-pii -> vgi-mask (format-preserving) composition.",
    },
    {
      name: "status",
      type: "VARCHAR",
      description: "The audit result (`result`, e.g. 'success' or 'failure').",
    },
    ...RESULT_COLUMNS_TAIL,
  ],
  examples: [
    {
      sql: "SELECT id, created_date_time, app_display_name, user_principal_name, status FROM azure.main.audit_logs() WHERE _row_kind IS NULL",
      description: "Backfill all available directory audit events (data rows only)",
    },
    {
      sql: "SELECT id, created_date_time, app_display_name FROM azure.main.audit_logs(since := '<prior _watermark_next>') WHERE _row_kind IS NULL",
      description: "Incremental scan replaying a previously saved high-watermark cursor",
    },
    {
      sql: "SELECT app_display_name, count(*) AS events FROM azure.main.audit_logs() WHERE _row_kind IS NULL GROUP BY app_display_name ORDER BY events DESC",
      description: "Count audit events per logging service",
    },
    {
      sql: "SELECT _watermark_next FROM azure.main.audit_logs() WHERE _row_kind = 'marker'",
      description: "Read the high-watermark cursor to persist for the next scan",
    },
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
