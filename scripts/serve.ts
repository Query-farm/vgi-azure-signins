// Serve the vgi-azure-signins worker over HTTP with the standardized VGI landing surface.
//
//   GET  /                                     → the shared vendored VGI landing.html
//   GET  /describe.json                        → the worker's catalog introspection
//   GET  /describe/{catalog}/{schema}/{t}.json → lazy per-object columns
//   GET  /health                               → JSON health endpoint
//   POST /                                     → the VGI RPC transport (what DuckDB attaches to)
//
// Run it:  PORT=8000 bun run scripts/serve.ts   (default port 8787)
// Attach:  ATTACH 'si' AS si (TYPE vgi, LOCATION 'http://localhost:8000');
//
// Everything below the worker's own identity — protocol assembly, state-token
// signing, CORS, the landing surface, Bun.serve — lives in the SDK's
// serveVgiWorker. Set VGI_SIGNING_KEY (64 hex chars) for any real deployment;
// without it the SDK generates an ephemeral key and warns.
//
// The wiring here mirrors src/worker.ts (the stdio entry): the same real MSAL-backed
// Graph client is injected into the same signin_logs / audit_logs table functions,
// same registry + catalog. serveVgiWorker needs NO azure credentials to boot — the
// functions stay credential-gated at query time (each requires an app-only
// `azure_graph` secret before it touches Microsoft Graph). Adding an endpoint means
// updating BOTH entries.

import { serveVgiWorker } from "@query-farm/vgi/serve";
import { ReadOnlyCatalogInterface, FunctionRegistry } from "@query-farm/vgi";
import { TokenCache, makeGraphClient, type Fetch } from "@vgi-azure/graph-core";
import { makeMsalMinter } from "@vgi-azure/node-auth";
import { makeWatermarkFunction } from "../src/functions.js";
import { SPECS } from "../src/schema.js";
import { makeCatalog } from "../src/catalog.js";

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
    audience: "graph",
  });

const functions = SPECS.map((spec) => makeWatermarkFunction(spec, clientFactory));

const registry = new FunctionRegistry();
for (const f of functions) registry.register(f);

const catalogInterface = new ReadOnlyCatalogInterface(makeCatalog(functions), registry);

serveVgiWorker({
  name: "signins",
  doc: "Microsoft Entra ID sign-in and directory audit logs as watermarked, incrementally ingestible DuckDB tables.",
  version: "0.1.0",
  repositoryUrl: "https://github.com/Query-farm/vgi-azure-signins",
  serverId: "vgi-azure-signins",
  registry,
  catalogInterface,
});
