// vgi-azure-signins stdio worker entry. DuckDB spawns this and ATTACHes it:
//   ATTACH 'si' AS si (TYPE vgi, LOCATION '/path/to/worker.ts');
//   CREATE SECRET g (TYPE azure_graph, TENANT_ID '…', CLIENT_ID '…', CLIENT_SECRET '…');
//   -- backfill (no since): reads from the start of retention
//   SELECT * FROM si.signin_logs()                       WHERE _row_kind IS NULL;
//   -- incremental: feed the prior marker's _watermark_next back as `since`
//   SELECT * FROM si.signin_logs(since := '<watermark>')  WHERE _row_kind IS NULL;
//   SELECT _watermark_next FROM si.signin_logs(since := '<watermark>') WHERE _row_kind='marker';
//   SELECT * FROM si.audit_logs(since := '<watermark>')   WHERE _row_kind IS NULL;
//
// Data rows have `_row_kind` NULL; exactly one `_row_kind='marker'` row carries the
// cursor in `_watermark_next`. The apply MUST be idempotent dedup-by-id
// (INSERT … ON CONFLICT (id) DO NOTHING) because the 'ge' + lag overlap re-emits the
// window tail every scan (SPEC §2.2). PII columns (ip_address, user_principal_name)
// are published through the mandatory vgi-pii -> vgi-mask (FPE) composition (SPEC §4.1).

import { Worker, ReadOnlyCatalogInterface, FunctionRegistry } from "@query-farm/vgi";
import { TokenCache, makeGraphClient, type Fetch } from "@vgi-azure/graph-core";
import { makeMsalMinter } from "@vgi-azure/node-auth";
import { makeWatermarkFunction } from "./functions.js";
import { SPECS } from "./schema.js";
import { makeCatalog } from "./catalog.js";

const cache = new TokenCache(makeMsalMinter());

const clientFactory = (secret: Record<string, unknown>) =>
  makeGraphClient({
    fetch: globalThis.fetch as unknown as Fetch,
    cache,
    cred: {
      tenantId: String(secret.tenant_id ?? ""),
      clientId: String(secret.client_id ?? ""),
      clientSecret: secret.client_secret != null ? String(secret.client_secret) : undefined,
    },
    // Audience is Microsoft Graph — this worker reads /auditLogs/* on graph.microsoft.com.
    audience: "graph",
  });

const functions = SPECS.map((spec) => makeWatermarkFunction(spec, clientFactory));

const registry = new FunctionRegistry();
for (const f of functions) registry.register(f);

const catalogInterface = new ReadOnlyCatalogInterface(makeCatalog(functions), registry);

new Worker({ functions, catalogInterface }).run();
