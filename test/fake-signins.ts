// A stateful fake of Microsoft Graph's /auditLogs/signIns endpoint — enough to prove
// the lagged-watermark cursor: an in-memory event store, `$filter=createdDateTime
// ge/le` window semantics, `$top` + multi-page `$skiptoken` paging, verbatim
// nextLink. No network, no @query-farm/* imports. Used only by the archetype-proof
// test. Also asserts the worker never sends `$orderby` (400s if it does, SPEC §1).

import type { FetchJson } from "@vgi-azure/graph-core";

const GRAPH = "https://graph.microsoft.com/v1.0";

export interface FakeEvent {
  id: string;
  createdDateTime: string; // ISO-8601 UTC (…Z)
  appDisplayName?: string;
  userPrincipalName?: string;
  ipAddress?: string;
  status?: { errorCode: number };
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
function unb64(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

export class FakeSignins {
  private events: FakeEvent[] = [];

  constructor(private readonly pageSize: number = 1000) {}

  /** Add / make an event queryable (models late arrival: call after scan 1). */
  add(e: FakeEvent): void {
    this.events.push({ ...e });
  }

  fetch: FetchJson = async (url) => {
    const u = new URL(url);

    // The worker must NEVER request $orderby on these endpoints (SPEC §1).
    if (u.searchParams.has("$orderby")) {
      const err = new Error("400: $orderby is not supported on /auditLogs/signIns") as Error & {
        status: number;
      };
      err.status = 400;
      throw err;
    }

    const sk = u.searchParams.get("$skiptoken");
    // Graph caps page size SERVER-side: the requested $top can only shrink a page,
    // never exceed the server's page size (modeled here by the fake's pageSize).
    const top = Math.min(Number(u.searchParams.get("$top") ?? this.pageSize), this.pageSize);

    let geMs = Number.NEGATIVE_INFINITY;
    let leMs = Number.POSITIVE_INFINITY;
    const filter = u.searchParams.get("$filter");
    if (filter) {
      // Parse the createdDateTime ge/le literals the worker builds.
      const ge = /createdDateTime\s+ge\s+(\S+)/i.exec(filter);
      const le = /createdDateTime\s+le\s+(\S+)/i.exec(filter);
      if (ge) geMs = Date.parse(ge[1]!);
      if (le) leMs = Date.parse(le[1]!);
    }

    // Window filter: ge is INCLUSIVE (the 'ge' overlap boundary), le inclusive.
    const matched = this.events.filter((e) => {
      const t = Date.parse(e.createdDateTime);
      return t >= geMs && t <= leMs;
    });

    const offset = sk ? (JSON.parse(unb64(sk)) as { offset: number }).offset : 0;
    const slice = matched.slice(offset, offset + top);
    const nextOffset = offset + top;

    if (nextOffset < matched.length) {
      const skiptoken = b64(JSON.stringify({ offset: nextOffset }));
      return {
        value: slice,
        "@odata.nextLink": `${GRAPH}/auditLogs/signIns?$skiptoken=${skiptoken}`,
      };
    }
    // Final page — NO deltaLink (these endpoints don't emit one; the cursor is the
    // caller-managed watermark, not a server token).
    return { value: slice };
  };
}
