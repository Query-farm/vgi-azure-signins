// The VGI table functions: signin_logs + audit_logs. Both come from one factory
// over the proven collectWindow driver. The GraphClient is injected so the worker
// wires the real MSAL-backed client and tests inject a fake.
//
// All cursors are TABLE functions so `name := value` works (vgi-scalar-no-named-args);
// the optional args live in `argDefaults` so they are named-arg capable. State is
// fully serializable — ISO strings, a plain URL, numbers, booleans, a done flag; NO
// RecordBatch, NO socket, NO Date (SPEC §4 / graph-core conformance checklist).

import { defineTableFunction, secretsOfType, type OutputCollector } from "@query-farm/vgi";
import { Utf8, Int64 } from "@query-farm/apache-arrow";
import { buildWindowUrl, collectWindow } from "./watermark-driver.js";
import { schemaFor, buildWatermarkBatch, type EndpointSpec } from "./schema.js";
import type { GraphClient } from "@vgi-azure/graph-core";

export type ClientFactory = (secret: Record<string, unknown>) => GraphClient;

/** Default safety lag: 10 minutes (SPEC §2.1 / §2.3). The '- lag' overlap is what
 *  re-captures late-arriving, boundary-unordered audit events on the next scan. */
export const DEFAULT_LAG_MIN = 10;
/** Graph caps sign-ins at 1000 rows/page ($top). */
export const DEFAULT_PAGE_SIZE = 1000;

interface Args {
  /** Already-lagged high-watermark from the prior scan (marker `_watermark_next`
   *  out). NULL/"" ⇒ backfill (no lower-bound filter). */
  since: string;
  /** Optional upper bound (createdDateTime le until). A CALLER-supplied `until` is
   *  historical replay and MUST NOT advance the live watermark (SPEC §2.5). */
  until: string;
  /** Extra additive OData $filter clause, AND-ed onto the time predicate. */
  filter: string;
  /** $top page size. */
  page_size: number;
  /** SAFETY_LAG override in minutes (SPEC §2.3). */
  lag_minutes: number;
}
interface State {
  done: boolean;
  /** The initial window URL — serializable; per-page nextLinks are followed inside
   *  the driver (in-scan paging), never held across scans. */
  startUrl: string;
  /** Floor: the watermark never goes below this. ISO string or "" for backfill. */
  since: string;
  lagMin: number;
  /** Historical replay: caller pinned `until` with no `since` — the marker is a
   *  replay-only cursor and MUST NOT be persisted as the live watermark (SPEC §2.5). */
  isReplay: boolean;
}

export function makeWatermarkFunction(spec: EndpointSpec, clientFactory: ClientFactory) {
  const schema = schemaFor(spec);
  return defineTableFunction<Args, State>({
    name: spec.fn,
    description: spec.description,
    args: {
      since: new Utf8(),
      until: new Utf8(),
      filter: new Utf8(),
      page_size: new Int64(),
      lag_minutes: new Int64(),
    },
    argDefaults: { since: "", until: "", filter: "", page_size: DEFAULT_PAGE_SIZE, lag_minutes: DEFAULT_LAG_MIN },
    argDocs: {
      since:
        "The already-lagged high-watermark from the prior scan (the marker row's `_watermark_next`), replayed as the lower bound (`createdDateTime ge <since>`). Empty (the default) performs a backfill from the start of retention with no lower bound.",
      until:
        "Optional upper bound (`createdDateTime le <until>`) for historical replay of a bounded window. A caller-supplied `until` is a replay-only cursor and must NOT be persisted as the live ingestion watermark. Empty (the default) means no upper bound.",
      filter:
        "An additional OData `$filter` expression AND-ed onto the time-window predicate to narrow the feed (e.g. `\"status/errorCode ne 0\"`). Empty (the default) applies no extra filter.",
      page_size:
        "The Microsoft Graph `$top` page size for each request. Graph caps sign-ins at 1000 rows per page; defaults to 1000. Pages are followed inside a single scan.",
      lag_minutes:
        "The safety-lag in minutes subtracted from the emitted high-watermark so late-arriving, boundary-unordered events are re-captured on the next scan. Defaults to 10. This overlap is why apply must be idempotent (dedup-by-id).",
    },
    examples: spec.examples,
    tags: {
      "vgi.category": "watermark-audit-feeds",
      "vgi.title": spec.title,
      "vgi.keywords": JSON.stringify(spec.keywords),
      "vgi.doc_llm": spec.docLlm,
      "vgi.doc_md": spec.docMd,
      "vgi.result_columns_schema": JSON.stringify(spec.resultColumns),
      // The native duckdb_functions().examples carrier drops per-example descriptions,
      // so re-publish the same {description, sql} examples as a described-JSON tag
      // (VGI515). Kept byte-identical to `examples` above.
      "vgi.example_queries": JSON.stringify(
        spec.examples.map((e) => ({ description: e.description, sql: e.sql })),
      ),
    },
    onBind: () => ({ outputSchema: schema }),
    initialState: (p) => {
      const since = p.args.since ? p.args.since : null;
      const until = p.args.until ? p.args.until : null;
      return {
        done: false,
        startUrl: buildWindowUrl(spec.endpoint, {
          since, // $filter createdDateTime ge <since> [and le <until>]
          until, // NO $orderby (400s — decorative, SPEC §1)
          extraFilter: p.args.filter ? p.args.filter : null,
          top: Number(p.args.page_size),
        }),
        since: p.args.since ?? "",
        lagMin: Number(p.args.lag_minutes),
        // Caller-supplied `until` WITHOUT `since` == historical replay window.
        isReplay: until != null && since == null,
      };
    },
    process: async (p, state: State, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const secret = secretsOfType(p.secrets, "azure_graph")[0];
      if (!secret) throw new Error(`${spec.fn}: attach an 'azure_graph' secret (TYPE azure_graph)`);
      const client = clientFactory(secret as Record<string, unknown>);

      const { rows, watermarkNext } = await collectWindow(client.fetchJson, state.startUrl, {
        since: state.since ? state.since : null,
        lagMs: state.lagMin * 60_000,
        // NOTE: a caller-supplied `until` (isReplay) still yields a `_watermark_next`
        // on the marker, but the operator persists it to THEIR replay cursor, never
        // the live ingestion watermark — that separation is the caller's, per SPEC §2.5.
      });

      // Business rows + exactly ONE strict marker row carrying `_watermark_next`.
      out.emit(buildWatermarkBatch(spec, schema, rows, watermarkNext));
      state.done = true; // next process() call hits the done branch and finishes.
    },
  });
}
