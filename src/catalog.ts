// The `azure` catalog descriptor + the azure_graph secret type. The secret shape
// (app-only client-credentials) is FROZEN by vgi-azure-directory (the graph-core
// seam owner); this worker reuses it verbatim — same `azure_graph` type, same
// fields, `client_secret` redacted.
//
// This file also carries the catalog- and schema-level vgi.* documentation/discovery
// tags that vgi-lint grades. Tag shapes follow vgi-lint's TAGS.md: JSON-valued tags
// (keywords/categories/executable_examples/agent_test_tasks/example_queries) are JSON
// strings; every example SQL is catalog-qualified (azure.main.<fn>) so it binds when the
// catalog is attached. The functions require an `azure_graph` secret + a live Graph call
// to RUN, so the executable examples are credential-free `LIMIT 0` bind/schema probes.

import { Schema, Field, Utf8 } from "@query-farm/apache-arrow";
import type { CatalogDescriptor, SecretTypeDescriptor, ViewDescriptor, VgiFunction } from "@query-farm/vgi";

const REPO = "https://github.com/Query-farm/vgi-azure-signins";
const ISSUES = `${REPO}/issues`;

export const AZURE_GRAPH_SECRET: SecretTypeDescriptor = {
  name: "azure_graph",
  description: "Microsoft Entra app-only (client-credentials) credentials for Microsoft Graph",
  schema: new Schema([
    new Field("tenant_id", new Utf8(), true),
    new Field("client_id", new Utf8(), true),
    new Field("client_secret", new Utf8(), true, new Map([["redact", "true"]])),
  ]),
};

/** Catalog-level tags: docs, discovery, provenance, and the agent-test suite. */
const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Microsoft Entra Audit & Sign-in Logs",
  "vgi.doc_llm":
    "Microsoft Entra ID (Azure AD) sign-in and directory audit logs as incremental SQL table " +
    "functions over Microsoft Graph. Reach for it to stream authentication and directory-activity " +
    "events into a warehouse: each scan returns the events whose createdDateTime falls in the " +
    "requested window, plus a marker row carrying the next high-watermark to persist. A first call " +
    "with no `since` backfills from the start of retention; passing a previously saved watermark as " +
    "`since` returns only newer events. The watermark is emitted with a safety lag so late-arriving, " +
    "boundary-unordered events are re-captured on the next scan — apply must therefore be idempotent " +
    "dedup-by-id (INSERT … ON CONFLICT (id) DO NOTHING). Requires an app-only (client-credentials) " +
    "'azure_graph' secret (tenant_id, client_id, client_secret) with AuditLog.Read.All; reading " +
    "sign-in logs additionally requires Entra ID P1/P2. The PII columns ip_address and " +
    "user_principal_name are published through the mandatory vgi-pii -> vgi-mask (format-preserving) " +
    "composition so masked values stay joinable across tables.",
  "vgi.doc_md":
    "## Microsoft Entra Audit & Sign-in Logs\n\n" +
    "Incremental (lagged-watermark) access to Microsoft Entra ID (Azure AD) audit and sign-in logs " +
    "via Microsoft Graph, exposed as two DuckDB table functions.\n\n" +
    "- **`signin_logs`** — Entra ID interactive sign-in events (`/auditLogs/signIns`); requires " +
    "Entra ID P1/P2.\n" +
    "- **`audit_logs`** — Entra ID directory audit / activity events (`/auditLogs/directoryAudits`); " +
    "available more broadly.\n\n" +
    "Each function returns events in the requested time window plus a single marker row " +
    "(`_row_kind = 'marker'`) whose `_watermark_next` column holds the ISO-8601 (already " +
    "lag-adjusted) high-watermark to persist and replay via the `since` argument on the next scan. " +
    "Call with no arguments to backfill; pass `since := '<watermark>'` for an incremental scan. Apply " +
    "idempotently (dedup-by-id) because the safety-lag overlap re-emits the window tail. An app-only " +
    "`azure_graph` secret is required.",
  "vgi.keywords": JSON.stringify([
    "azure",
    "entra id",
    "azure ad",
    "microsoft graph",
    "sign-in",
    "signin",
    "audit",
    "auditlogs",
    "authentication",
    "activity logs",
    "watermark",
    "incremental",
    "security",
    "identity",
  ]),
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC",
  "vgi.license": "MIT",
  "vgi.support_contact": ISSUES,
  "vgi.support_policy_url": ISSUES,
  // Guaranteed-runnable, catalog-qualified examples (VGI509/VGI906). A LIVE scan needs an
  // attached azure_graph secret and a network call to Microsoft Graph, so these are
  // credential-free `LIMIT 0` schema/bind probes: DuckDB binds and plans the query (onBind
  // runs, which needs no secret) but never pumps the scan, so process() (where the secret and
  // network live) is never reached. This verifies each function binds and exposes its exact
  // result columns without fetching. Drop the `LIMIT 0` and attach an azure_graph secret to
  // pull real rows — the fuller, data-returning queries live in each function's `examples`
  // and the schema `vgi.example_queries`.
  "vgi.executable_examples": JSON.stringify([
    {
      name: "signin_logs_bind_probe",
      description:
        "Bind signin_logs and expose its result columns (credential-free; drop LIMIT 0 and attach an azure_graph secret to sync real sign-in events)",
      sql: "SELECT id, created_date_time, app_display_name, user_principal_name, ip_address, status FROM azure.main.signin_logs() LIMIT 0",
    },
    {
      name: "audit_logs_bind_probe",
      description:
        "Bind audit_logs and expose its result columns (credential-free; attach an azure_graph secret to sync real audit events)",
      sql: "SELECT id, created_date_time, app_display_name, user_principal_name, ip_address, status FROM azure.main.audit_logs() LIMIT 0",
    },
  ]),
  // The agent-suitability suite (VGI152), catalog only. Scans require an azure_graph secret
  // and return tenant-specific, non-deterministic data, so these tasks are graded by
  // success_criteria (LLM judge) rather than a reference_sql / check_sql oracle (which would
  // need live credentials and stable ground truth).
  "vgi.agent_test_tasks": JSON.stringify([
    {
      name: "recent_signins",
      prompt: "Show the most recent sign-in events with the user principal name and the application they signed in to.",
      reference_sql:
        "SELECT user_principal_name, app_display_name, created_date_time FROM azure.main.signin_logs() WHERE _row_kind IS NULL ORDER BY created_date_time DESC",
      success_criteria:
        "The answer queries azure.main.signin_logs(), filters to data rows (_row_kind IS NULL), and returns user_principal_name, app_display_name, and created_date_time (optionally ordered by created_date_time descending).",
    },
    {
      name: "failed_signins_by_app",
      prompt: "Which applications had the most failed sign-ins?",
      reference_sql:
        "SELECT app_display_name, count(*) AS failures FROM azure.main.signin_logs() WHERE _row_kind IS NULL AND status <> '0' GROUP BY app_display_name ORDER BY failures DESC",
      success_criteria:
        "The answer queries signin_logs(), filters data rows where status <> '0' (a non-zero errorCode means a failed sign-in), groups by app_display_name, and orders by the failure count descending.",
    },
    {
      name: "save_watermark_cursor",
      prompt: "After a sign-in scan, how do I get the cursor to use for the next incremental scan?",
      reference_sql:
        "SELECT _watermark_next FROM azure.main.signin_logs() WHERE _row_kind = 'marker'",
      success_criteria:
        "The answer selects _watermark_next from the marker row (_row_kind = 'marker') of signin_logs() and explains it should be replayed via the `since` argument, with apply being idempotent dedup-by-id because of the safety-lag overlap.",
    },
    {
      name: "audit_activity",
      prompt: "List directory audit events grouped by the service that logged them.",
      reference_sql:
        "SELECT app_display_name, count(*) AS events FROM azure.main.audit_logs() WHERE _row_kind IS NULL GROUP BY app_display_name ORDER BY events DESC",
      success_criteria:
        "The answer queries azure.main.audit_logs(), filters to data rows (_row_kind IS NULL), and aggregates a count grouped by app_display_name (the loggedByService).",
    },
    {
      name: "browse_feeds",
      prompt: "What audit feeds can I sync, and which table function serves each?",
      reference_sql:
        "SELECT feed, table_function FROM azure.main.audit_feeds ORDER BY feed",
      success_criteria:
        "The answer reads azure.main.audit_feeds and lists the feeds (sign-in logs, directory audit logs) alongside the table function that serves each.",
    },
  ]),
};

/** Schema-level tags: docs, discovery, the category registry, and shown examples. */
const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Entra Audit & Sign-in Logs",
  "vgi.doc_llm":
    "The Microsoft Entra ID audit and sign-in log feed functions. Each function is an incremental " +
    "feed for one Graph audit endpoint — sign-in events or directory audit events — cursored by a " +
    "lagged high-watermark on createdDateTime. A scan returns events in the requested time window " +
    "followed by one marker row whose _watermark_next column is the cursor to persist and replay via " +
    "the `since` argument. Omit `since` for a backfill; the safety-lag overlap re-emits the window " +
    "tail so apply must be idempotent dedup-by-id.",
  "vgi.doc_md":
    "## Entra audit & sign-in log feeds\n\n" +
    "| Function | Graph endpoint | Returns |\n" +
    "| --- | --- | --- |\n" +
    "| `signin_logs` | `/auditLogs/signIns` | sign-in events + watermark cursor |\n" +
    "| `audit_logs` | `/auditLogs/directoryAudits` | directory audit events + watermark cursor |\n\n" +
    "Both share the same shape: read data rows with `WHERE _row_kind IS NULL`, and take the next " +
    "cursor from the single marker row's `_watermark_next` (feed it back as `since`). Apply " +
    "idempotently (dedup-by-id). Each requires an app-only `azure_graph` secret.",
  "vgi.keywords": JSON.stringify([
    "entra id",
    "azure ad",
    "sign-in",
    "audit",
    "auditlogs",
    "authentication",
    "activity logs",
    "watermark",
    "incremental",
    "security",
    "identity",
  ]),
  domain: "security",
  // Ordered navigation registry; each `name` is referenced by a function's vgi.category.
  "vgi.categories": JSON.stringify([
    {
      name: "discovery",
      title: "Discovery",
      description:
        "Browsable, credential-free entry points for finding your way around the audit-log catalog.",
    },
    {
      name: "watermark-audit-feeds",
      title: "Audit & Sign-in Log Feeds",
      description:
        "Incremental, lagged-watermark feeds for Microsoft Entra ID audit and sign-in logs via Microsoft Graph, cursored on createdDateTime.",
    },
  ]),
  "vgi.example_queries": JSON.stringify([
    {
      description: "Backfill all available sign-in events",
      sql: "SELECT id, created_date_time, app_display_name, user_principal_name FROM azure.main.signin_logs() WHERE _row_kind IS NULL",
    },
    {
      description: "Incremental sign-in scan from a saved watermark",
      sql: "SELECT id, created_date_time, app_display_name FROM azure.main.signin_logs(since := '<prior _watermark_next>') WHERE _row_kind IS NULL",
    },
    {
      description: "Failed sign-ins per application (non-zero errorCode)",
      sql: "SELECT app_display_name, count(*) AS failures FROM azure.main.signin_logs() WHERE _row_kind IS NULL AND status <> '0' GROUP BY app_display_name ORDER BY failures DESC",
    },
    {
      description: "Read the sign-in watermark cursor to persist for the next scan",
      sql: "SELECT _watermark_next FROM azure.main.signin_logs() WHERE _row_kind = 'marker'",
    },
    {
      description: "Directory audit events grouped by logging service",
      sql: "SELECT app_display_name, count(*) AS events FROM azure.main.audit_logs() WHERE _row_kind IS NULL GROUP BY app_display_name ORDER BY events DESC",
    },
  ]),
};

// A browsable, credential-free discovery view: the two audit feeds, the table function
// that serves each, its Graph endpoint, and a one-line description. Its definition is a
// self-contained VALUES relation evaluated entirely by DuckDB (no worker call, no secret),
// so an agent can `SELECT * FROM azure.main.audit_feeds` to learn the surface before it
// ever needs Microsoft Graph credentials. This is the worker's browsable entry point
// (VGI146): every other object here is a credential-gated table function.
const AUDIT_FEEDS_VIEW: ViewDescriptor = {
  name: "audit_feeds",
  definition:
    "SELECT feed, table_function, graph_endpoint, description FROM (VALUES " +
    "('sign-in logs', 'signin_logs', '/auditLogs/signIns', 'Microsoft Entra ID interactive sign-in events (requires Entra ID P1/P2)'), " +
    "('directory audit logs', 'audit_logs', '/auditLogs/directoryAudits', 'Microsoft Entra ID directory audit / activity events (available more broadly)')" +
    ") AS t(feed, table_function, graph_endpoint, description)",
  comment:
    "The audit feeds this catalog exposes (sign-in logs, directory audit logs) and the watermark table function that serves each. Browsable without credentials.",
  columnComments: {
    feed: "The audit feed's human name (sign-in logs / directory audit logs).",
    table_function: "The catalog table function that syncs this feed as a lagged-watermark incremental feed.",
    graph_endpoint: "The Microsoft Graph endpoint the feed reads from.",
    description: "A one-line description of the feed.",
  },
  tags: {
    "vgi.title": "Audit Feed Index",
    "vgi.category": "discovery",
    domain: "security",
    "vgi.doc_llm":
      "A static, credential-free catalog of the audit feeds this worker exposes: one row per feed " +
      "(sign-in logs, directory audit logs) giving the table function that syncs it as a lagged-watermark " +
      "incremental feed over Microsoft Graph, its Graph endpoint, and a short description. Query it to " +
      "discover the worker's surface before attaching an azure_graph secret.",
    "vgi.doc_md":
      "## audit_feeds\n\n" +
      "A browsable, credential-free index of the audit feeds this catalog exposes. One row per feed, " +
      "naming the watermark table function that syncs it. Start here, then call the named function " +
      "(with an `azure_graph` secret attached) to sync that feed.",
    "vgi.keywords": JSON.stringify([
      "audit",
      "feeds",
      "catalog",
      "discovery",
      "sign-in",
      "signin",
      "directory audits",
      "table functions",
    ]),
    "vgi.example_queries": JSON.stringify([
      {
        description: "List every audit feed and the table function that serves it",
        sql: "SELECT feed, table_function FROM azure.main.audit_feeds ORDER BY feed",
      },
      {
        description: "Find the Graph endpoint backing the sign-in feed",
        sql: "SELECT graph_endpoint FROM azure.main.audit_feeds WHERE table_function = 'signin_logs'",
      },
    ]),
  },
};

export function makeCatalog(functions: VgiFunction[]): CatalogDescriptor {
  return {
    name: "azure",
    defaultSchema: "main",
    comment:
      "Microsoft Entra sign-in & directory audit logs via Graph (lagged-watermark cursor) — vgi-azure-signins",
    sourceUrl: REPO,
    tags: CATALOG_TAGS,
    secretTypes: [AZURE_GRAPH_SECRET],
    schemas: [
      {
        name: "main",
        comment: "Microsoft Entra ID sign-in and directory audit logs as incremental Graph watermark feeds.",
        tags: SCHEMA_TAGS,
        views: [AUDIT_FEEDS_VIEW],
        functions,
      },
    ],
  };
}
