# vgi-azure-signins

A [VGI](https://query.farm) worker (**Microsoft Entra Audit & Sign-in Logs**) for DuckDB. Microsoft Entra ID (Azure AD) sign-in and directory audit logs as incremental DuckDB table functions over Microsoft Graph: `signin_logs` (interactive sign-in events) and `audit_logs` (directory audit / activity events). Each scan returns the events in the requested window plus a single marker row (`_row_kind = 'marker'`) whose `_watermark_next` is the lag-adjusted high-watermark to pass back as `since`; call with no arguments to backfill. The safety lag re-emits the window tail, so apply idempotently (dedup by `id`, e.g. `INSERT ... ON CONFLICT (id) DO NOTHING`).

## Quick start

Every [GitHub release](https://github.com/Query-farm/vgi-azure-signins/releases) ships a prebuilt worker binary. The `vgi` extension downloads the one for your platform, checks its SHA-256 and caches it, so there is nothing to install besides DuckDB:

```sql
INSTALL vgi FROM community;
LOAD vgi;

ATTACH 'azure' AS azure (TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-azure-signins@v0.2.1');

-- Bind signin_logs and expose its result columns (credential-free; drop LIMIT 0 and
-- attach an azure_graph secret to sync real sign-in events)
SELECT id, created_date_time, app_display_name, user_principal_name, ip_address, status FROM azure.main.signin_logs() LIMIT 0;

-- Bind audit_logs and expose its result columns (credential-free; attach an azure_graph
-- secret to sync real audit events)
SELECT id, created_date_time, app_display_name, user_principal_name, ip_address, status FROM azure.main.audit_logs() LIMIT 0;
```

The examples are credential-free `LIMIT 0` bind probes: they check that each function binds and show its result columns without calling Azure. To pull real rows, create an `azure_graph` secret (see [Credentials](#credentials)) and drop the `LIMIT 0`.

All the Query Farm Azure workers use the catalog name `azure`. To attach more than one in the same session, give each its own alias (for example `ATTACH 'azure' AS azure_signins (...)`) and qualify queries with that alias instead of `azure`.

Prebuilt binaries cover macOS (Apple silicon), Linux (x86-64 and arm64). `github-auto://` needs an explicit release tag; change `@v0.2.1` to move to a newer release.

### Other ways to run it

- **Docker** (the image bundles the worker; needs a container runtime):

  ```sql
  ATTACH 'azure' AS azure (TYPE vgi, LOCATION 'docker://ghcr.io/query-farm/vgi-azure-signins:0.2.1');
  ```

- **Manual download.** Download the archive for your platform from the [releases page](https://github.com/Query-farm/vgi-azure-signins/releases), verify it against its `.sha256` file (a cosign `.cosign.bundle` is published alongside), unpack it, and set `LOCATION` to the path of the extracted worker executable.

### Build from source

To build and test the worker yourself, see [Development](#development).

## Credentials

Live queries authenticate with an `azure_graph` secret holding app-only Microsoft Entra client credentials for a service principal: `TENANT_ID`, `CLIENT_ID` and `CLIENT_SECRET` (the client secret is redacted when secrets are listed). The worker registers the `azure_graph` secret type when it is attached, so create the secret after the `ATTACH`:

```sql
ATTACH 'azure' AS azure (TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-azure-signins@v0.2.1');
CREATE SECRET azure_sp (TYPE azure_graph, TENANT_ID '<tenant-guid>', CLIENT_ID '<app-guid>', CLIENT_SECRET '<secret>');
```

For this worker the service principal needs the Microsoft Graph application permission `AuditLog.Read.All`; reading sign-in logs additionally requires an Entra ID P1 or P2 license.

## Development

Requires [Bun](https://bun.sh). `bun install` also fetches the shared `@vgi-azure/graph-core` package from GitHub.

```bash
bun install && bun test
bun run typecheck
```

To attach a local checkout, point `LOCATION` at the launch wrapper:

```sql
ATTACH 'azure' AS azure (TYPE vgi, LOCATION '/path/to/vgi-azure-signins/bin/vgi-azure-signins-worker');
```

## License

MIT. See [LICENSE](LICENSE).
