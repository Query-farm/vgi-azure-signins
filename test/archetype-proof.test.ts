// THE archetype proof for vgi-azure-signins: the lagged-watermark cursor over a
// messy, late-arriving, boundary-unordered Graph audit log. Imports ONLY
// @vgi-azure/graph-core + our own src + bun:test — NO @query-farm/* — so it runs
// without the SDK installed. It drives the pure driver (watermark-driver.ts) end to
// end against an in-process FakeSignins, proving the cursor archetype:
//
//   (a) a full window emits every business row AND yields a watermark (the ISO the
//       marker row will carry — WATERMARK_NEXT);
//   (b) QUIET-TENANT clamp: even when maxSeen << now-lag, the persisted watermark
//       sits EXACTLY `lag` behind maxSeen (graph-core clampWatermark, committee
//       must-fix #1 — a hand-rolled min(max, now-lag) would apply zero lag here);
//   (c) re-scan from the watermark uses a `ge` (inclusive) boundary, so the tail of
//       the previous window is RE-READ — the overlap that re-captures late arrivals.
//
// Plus the two contracts that make (c) matter: the late-arrival no-loss / dedup-by-id
// story (the reason this worker exists, SPEC §2.2/§7), the quiet/empty-window guard
// (SPEC §2.4 — never clamp a null maxSeen into a NaN cursor), and the lag-zero
// negative control (SPEC §7 #10 — prove loss occurs, locking in WHY the lag exists).

import { test, expect } from "bun:test";
import { clampWatermark, isoToMs, msToIso } from "@vgi-azure/graph-core";
import { buildWindowUrl, collectWindow, CURSOR_FIELD } from "../src/watermark-driver.js";
import { FakeSignins, type FakeEvent } from "./fake-signins.js";

const LAG_MIN = 10;
const LAG_MS = LAG_MIN * 60_000;

// A quiet tenant: `now` sits ~2h past the newest event, so maxSeen << now - lag.
// This is the case where a naive `min(max, now-lag)` would apply ZERO lag.
const NOW_ISO = "2026-07-04T12:00:00Z";
const nowMs = isoToMs(NOW_ISO);
const now = () => nowMs;

const E1: FakeEvent = { id: "s1", createdDateTime: "2026-07-04T10:00:00Z", appDisplayName: "Portal", userPrincipalName: "a@x", ipAddress: "10.0.0.1", status: { errorCode: 0 } };
const E2: FakeEvent = { id: "s2", createdDateTime: "2026-07-04T10:05:00Z", appDisplayName: "Portal", userPrincipalName: "b@x", ipAddress: "10.0.0.2", status: { errorCode: 0 } };
const E3: FakeEvent = { id: "s3", createdDateTime: "2026-07-04T10:10:00Z", appDisplayName: "Portal", userPrincipalName: "c@x", ipAddress: "10.0.0.3", status: { errorCode: 50126 } };
const MAX_SEEN_ISO = E3.createdDateTime; // 10:10 — the high-water of the window

function seeded(pageSize = 1000): FakeSignins {
  const g = new FakeSignins(pageSize);
  g.add(E1);
  g.add(E2);
  g.add(E3);
  return g;
}

/** The initial backfill window (no `since`) — the driver builds the start URL. */
function backfillUrl(): string {
  return buildWindowUrl("signIns", { since: null, until: null, extraFilter: null, top: 1000 });
}

// --- (a) full window emits rows + a watermark marker ------------------------------

test("(a) full window: every business row is emitted AND a watermark cursor is produced", async () => {
  const g = seeded();
  const r = await collectWindow(g.fetch, backfillUrl(), { since: null, lagMs: LAG_MS, now });

  expect(r.rows.map((x) => x.id).sort()).toEqual(["s1", "s2", "s3"]);
  // The watermark that the strict marker row will carry (_watermark_next), ISO, non-null.
  expect(typeof r.watermarkNext).toBe("string");
  expect(r.watermarkNext.length).toBeGreaterThan(0);
  // Backfill: no lower-bound time predicate, and NEVER $orderby (400s, SPEC §1).
  const url = new URL(backfillUrl());
  expect(url.searchParams.has("$orderby")).toBe(false);
  expect(url.searchParams.has("$filter")).toBe(false);
  expect(url.searchParams.get("$top")).toBe("1000");
});

test("(a) paging: nextLink is followed verbatim across pages, all rows land once", async () => {
  const g = seeded(/*pageSize*/ 2); // 3 events → page1 (2) + page2 (1)
  let fetches = 0;
  const counting = async (u: string) => { fetches++; return g.fetch(u); };

  const r = await collectWindow(counting, backfillUrl(), { since: null, lagMs: LAG_MS, now });
  expect(fetches).toBe(2);
  expect(r.rows.map((x) => x.id).sort()).toEqual(["s1", "s2", "s3"]);
});

// --- (b) quiet-tenant clamp keeps the watermark `lag` behind maxSeen --------------

test("(b) QUIET-TENANT clamp: watermark sits EXACTLY lag behind maxSeen (never zero lag)", async () => {
  const g = seeded();
  const r = await collectWindow(g.fetch, backfillUrl(), { since: null, lagMs: LAG_MS, now });

  const maxSeenMs = isoToMs(MAX_SEEN_ISO);
  // now is ~2h past maxSeen, so min(maxSeen, now) = maxSeen; the `- lag` is unconditional.
  const expected = msToIso(clampWatermark(maxSeenMs, LAG_MS, nowMs));
  expect(r.watermarkNext).toBe(expected);
  expect(isoToMs(r.watermarkNext)).toBe(maxSeenMs - LAG_MS); // lag behind maxSeen, not now
  expect(isoToMs(r.watermarkNext)).toBeLessThan(maxSeenMs);  // strictly behind the newest event
});

// --- (c) re-scan from the watermark uses a `ge` (inclusive) overlap boundary ------

test("(c) re-scan from the watermark uses a `ge` overlap boundary (tail re-read)", async () => {
  const g = seeded();
  const r1 = await collectWindow(g.fetch, backfillUrl(), { since: null, lagMs: LAG_MS, now });
  const W1 = r1.watermarkNext; // 10:00 — clampWatermark(10:10, 10m, now)
  expect(W1).toBe("2026-07-04T10:00:00.000Z");

  // The next scan's start URL filters `createdDateTime ge <W1>` — INCLUSIVE, not `gt`.
  const url2 = buildWindowUrl("signIns", { since: W1, until: null, extraFilter: null, top: 1000 });
  const filter = new URL(url2).searchParams.get("$filter") ?? "";
  expect(filter).toContain(`${CURSOR_FIELD} ge `);
  expect(filter).not.toContain(`${CURSOR_FIELD} gt `);

  // Drive it: the boundary event E1 (at exactly W1) is RE-READ — a `gt` cursor would
  // have dropped it. That inclusive overlap is what makes late-arrival capture work.
  const r2 = await collectWindow(g.fetch, url2, { since: W1, lagMs: LAG_MS, now });
  expect(r2.rows.map((x) => x.id)).toContain("s1"); // exactly-at-boundary row survives
});

// --- late-arrival no-loss + idempotent dedup-by-id (the reason this worker exists) --

test("late arrival inside (W1, maxSeen] is re-captured by the ge overlap; dedup-by-id → no loss, no dup", async () => {
  type Store = Map<string, FakeEvent>;
  const applyDedup = (store: Store, rows: Record<string, unknown>[]) => {
    for (const r of rows) {
      const id = String(r.id);
      if (!store.has(id)) store.set(id, r as unknown as FakeEvent); // INSERT … ON CONFLICT (id) DO NOTHING
    }
  };

  const g = seeded();
  const store: Store = new Map();

  // Scan 1 over the full window → commit rows + watermark W1 = 10:00.
  const r1 = await collectWindow(g.fetch, backfillUrl(), { since: null, lagMs: LAG_MS, now });
  applyDedup(store, r1.rows);
  const W1 = r1.watermarkNext;
  expect(W1).toBe("2026-07-04T10:00:00.000Z");

  // A late event becomes queryable AFTER scan 1, with createdDateTime in (W1, maxSeen)
  // = (10:00, 10:10) — exactly the event a naive `gt maxSeen` cursor would skip.
  const eLate: FakeEvent = { id: "sLATE", createdDateTime: "2026-07-04T10:07:00Z", appDisplayName: "CLI", userPrincipalName: "late@x", ipAddress: "10.0.0.9", status: { errorCode: 0 } };
  g.add(eLate);

  // Scan 2 re-queries `ge W1`: the overlap re-emits the tail (s1..s3) AND catches sLATE.
  const url2 = buildWindowUrl("signIns", { since: W1, until: null, extraFilter: null, top: 1000 });
  const r2 = await collectWindow(g.fetch, url2, { since: W1, lagMs: LAG_MS, now });
  expect(r2.rows.map((x) => x.id)).toContain("sLATE"); // late arrival recaptured

  applyDedup(store, r2.rows); // overlap tail collides on id → dropped

  // At-least-once capture + idempotent dedup = exactly-once effect: late event present,
  // and no row duplicated despite the deliberate overlap re-read.
  expect([...store.keys()].sort()).toEqual(["s1", "s2", "s3", "sLATE"]);
});

// --- quiet/empty-window guard (SPEC §2.4): never clamp a null maxSeen into NaN -----

test("empty window: watermark == since (no advance, no rewind, no NaN cursor)", async () => {
  const g = seeded();
  const since = "2026-07-04T11:00:00Z"; // above every event (10:00..10:10) → zero matches
  const url = buildWindowUrl("signIns", { since, until: null, extraFilter: null, top: 1000 });

  const r = await collectWindow(g.fetch, url, { since, lagMs: LAG_MS, now });
  expect(r.rows.length).toBe(0);
  expect(r.watermarkNext).toBe(since); // held verbatim; clampWatermark NOT called (no NaN)
});

// --- lag-zero negative control (SPEC §7 #10): prove loss occurs, so a future
//     "optimization" that drops the lag fails CI --------------------------------------

test("lag_minutes := 0 (no overlap) LOSES the late arrival — this is WHY the lag exists", async () => {
  const g = seeded();
  const r1 = await collectWindow(g.fetch, backfillUrl(), { since: null, lagMs: 0, now });
  const W1 = r1.watermarkNext;
  expect(W1).toBe(msToIso(isoToMs(MAX_SEEN_ISO))); // zero lag → watermark == maxSeen (10:10)

  // Same late event in the (would-be) overlap band, now BELOW the zero-lag watermark.
  g.add({ id: "sLATE", createdDateTime: "2026-07-04T10:07:00Z", ipAddress: "10.0.0.9" });

  // `ge 10:10` excludes 10:07 → the late arrival is silently dropped. Loss, by design
  // of lag=0 — the assertion that locks the safety lag in place.
  const url2 = buildWindowUrl("signIns", { since: W1, until: null, extraFilter: null, top: 1000 });
  const r2 = await collectWindow(g.fetch, url2, { since: W1, lagMs: 0, now });
  expect(r2.rows.map((x) => x.id)).not.toContain("sLATE");
});
