// The lagged-watermark driver — pure logic over graph-core, no SDK / no network.
// One driver serves signin_logs and audit_logs: both are paged, time-filtered Graph
// audit collections with NO delta token, so the ONLY durable cursor is a
// high-watermark createdDateTime string. This is the module the archetype-proof
// test exercises (quiet-tenant clamp + 'ge' overlap re-capture of late arrivals).
//
// The cursor discipline (frozen by graph-core-SPEC decision C / signins-SPEC §2):
//   next = clampWatermark(maxSeen, lagMs, now) = min(maxSeen, now) - lagMs
//   boundary is 'ge' (NOT 'gt') so each scan re-reads the last `lag` minutes;
//   at-least-once capture + idempotent dedup-by-id = exactly-once effect.
// The '- lag' is UNCONDITIONAL (via graph-core clampWatermark), so a QUIET tenant
// (maxSeen far below now-lag) still sits `lag` behind maxSeen and re-captures late
// arrivals. lag_minutes := 0 removes the overlap → provable loss (SPEC §7 #10).

import {
  paginate,
  clampWatermark,
  isoToMs,
  msToIso,
  foldMaxSeen,
  type FetchJson,
} from "@vgi-azure/graph-core";

const GRAPH = "https://graph.microsoft.com/v1.0";

export type Endpoint = "signIns" | "directoryAudits";

/** Advanced OData operators that force $count=true + ConsistencyLevel: eventual. */
const ADVANCED = /(?:^|[\s(])(?:ne|not|endsWith|startsWith)\b|\$count/i;

/** Graph field the cursor predicate filters on. Both endpoints use createdDateTime
 *  (audits ALSO expose activityDateTime, but createdDateTime is the indexed,
 *  cursor-stable field — see SPEC §4). */
export const CURSOR_FIELD = "createdDateTime";

export interface UrlOpts {
  /** Already-lagged high-watermark from the prior scan; null ⇒ backfill (no floor). */
  since: string | null;
  /** Optional upper bound (createdDateTime le until). */
  until: string | null;
  /** Caller-supplied EXTRA $filter clause, AND-ed onto the time predicate. */
  extraFilter: string | null;
  /** $top page size. */
  top: number;
}

/** Guard: a caller filter must never touch the cursor field (would break the
 *  overlap cursor, SPEC §4). */
function assertAdditive(extra: string): void {
  if (new RegExp(`\\b${CURSOR_FIELD}\\b`, "i").test(extra)) {
    throw new Error(
      `filter must not reference ${CURSOR_FIELD} (cursor integrity): the worker owns the time predicate`,
    );
  }
}

/**
 * Build the initial page URL for an endpoint window.
 *
 * - `$filter=createdDateTime ge <since> [and createdDateTime le <until>]`, merged
 *   with a validated additive caller `extraFilter`.
 * - `$top=<n>`. NO `$orderby` — the sign-in / audit endpoints 400 on it and the
 *   watermark is order-independent (SPEC §1), so ordering was only decorative.
 * - Advanced-operator auto-inject: `ne`/`not`/`endsWith`/`$count` ⇒ add
 *   `$count=true` (the caller must also send `ConsistencyLevel: eventual`, exposed
 *   via `consistencyEventual`).
 */
export function buildWindowUrl(endpoint: Endpoint, o: UrlOpts): string {
  const clauses: string[] = [];
  if (o.since) clauses.push(`${CURSOR_FIELD} ge ${o.since}`);
  if (o.until) clauses.push(`${CURSOR_FIELD} le ${o.until}`);
  if (o.extraFilter && o.extraFilter.trim()) {
    assertAdditive(o.extraFilter);
    clauses.push(`(${o.extraFilter.trim()})`);
  }

  const params = new URLSearchParams();
  if (clauses.length) params.set("$filter", clauses.join(" and "));
  params.set("$top", String(o.top));
  if (o.extraFilter && ADVANCED.test(o.extraFilter)) params.set("$count", "true");
  // NOTE: deliberately NO $orderby (400s on these endpoints — decorative, SPEC §1).

  return `${GRAPH}/auditLogs/${endpoint}?${params.toString()}`;
}

/** True when the caller filter needs the `ConsistencyLevel: eventual` header. */
export function needsConsistencyEventual(extraFilter: string | null): boolean {
  return !!extraFilter && ADVANCED.test(extraFilter);
}

export interface WatermarkResult {
  /** Raw event objects across every page of the window (dedup-by-id is the caller's
   *  idempotent apply job; the overlap window intentionally re-emits the tail). */
  rows: Record<string, unknown>[];
  /** The ISO watermark to persist as the cursor for the next scan. For a quiet /
   *  empty window this equals `since` (never rewinds, never advances). */
  watermarkNext: string;
}

/**
 * Drain a time-bounded window to completion from `startUrl`, following every opaque
 * `@odata.nextLink` verbatim, then compute the next watermark.
 *
 *   maxSeen  = max(createdDateTime) over ALL emitted rows (order-independent fold)
 *   next     = maxSeen == null            → since   (quiet window: DO NOT advance/
 *                                                     rewind; NEVER call clamp with
 *                                                     null → NaN, SPEC §2.4)
 *              else isoMax(clampWatermark(maxSeen, lagMs, now), since)  // never rewind
 *
 * The loss-safety contract lives in the CALLER: persist `watermarkNext` only after
 * the rows are durably applied. On crash the caller still holds the old `since`; the
 * next scan re-reads the SAME overlapping window (`ge` boundary) → re-delivery,
 * deduped on `id` (SPEC §2.2).
 */
export async function collectWindow(
  fetchJson: FetchJson,
  startUrl: string,
  opts: { since: string | null; lagMs: number; now?: () => number },
): Promise<WatermarkResult> {
  const now = opts.now ?? (() => Date.now());
  const sinceMs = opts.since ? isoToMs(opts.since) : null;

  const rows: Record<string, unknown>[] = [];
  let maxSeenMs: number | null = null;

  for await (const page of paginate<Record<string, unknown>>(fetchJson, startUrl)) {
    for (const obj of page.value) rows.push(obj);
    const times: number[] = [];
    for (const obj of page.value) {
      const t = obj[CURSOR_FIELD];
      if (typeof t === "string") times.push(isoToMs(t));
    }
    if (times.length) maxSeenMs = foldMaxSeen(maxSeenMs ?? Number.NEGATIVE_INFINITY, times);
  }

  // Empty / quiet window: maxSeen === null → the watermark does NOT advance and does
  // NOT rewind. Skip clampWatermark ENTIRELY (clampWatermark(NaN,…) would poison the
  // cursor, SPEC §2.4). A quiet tenant must not rewind or drop the cursor.
  if (maxSeenMs == null) {
    return { rows, watermarkNext: opts.since ?? "" };
  }

  // Route the real watermark through the canonical clamp: min(maxSeen, now) - lag,
  // UNCONDITIONALLY. Then never let it fall below the floor `since` (quiet-window
  // monotonicity — a lagged clamp on a small window must not rewind past `since`).
  const clampedMs = clampWatermark(maxSeenMs, opts.lagMs, now());
  const flooredMs = sinceMs == null ? clampedMs : Math.max(clampedMs, sinceMs);
  return { rows, watermarkNext: msToIso(flooredMs) };
}
