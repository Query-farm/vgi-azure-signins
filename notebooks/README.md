# Sign-in replay notebooks

[01 · Count sign-ins once, including late arrivals](01_late_arrivals_and_counts.ipynb)
compares blind append, a sink keyed by event ID, and a fresh reference scan. Two
late-visible events exercise the real worker's lagged watermark. SQL keeps unknown
outcomes distinct and measures how duplicates or missing events affect failure
rates. All input metadata is synthetic; two executed figures are embedded.

## Install and run

Install [uv](https://docs.astral.sh/uv/), [Bun](https://bun.sh/) and Git. Validation
used Bun **1.3.14**. This directory runs after being copied away from the worker
repository; it needs no parent source checkout or root Python environment:

```sh
uv sync --locked
uv run --locked python execute.py --timeout 300
```

The separate lock pins Haybarn **2.0.0rc11**, JupySQL, plotting and execution tools.
The runner uses a temporary kernel with its interpreter and this directory as cwd.
It atomically replaces the saved notebook only after success. Overrides require a
separate destination. For an existing Jupyter frontend:

```sh
uv run --locked python -m ipykernel install --user \
  --name vgi-azure-signins-notebooks --display-name "Python (vgi-azure-signins notebooks)"
```

Select that kernel and **Restart Kernel → Run All** after changing parameters.
The runner does not register a global kernel. First runs require downloads.

## Visible portable connections

Native `github-auto://Query-farm/vgi-azure-signins@v0.4.0` supplies credential-free
`audit_feeds` discovery. The analytical connection uses the literal location
`bash launch_fixture.sh`. The launcher clones public remote revision
**007b39947658892a6cd9c949c9d53faaf09d126e** into ignored `artifacts/`, verifies its
revision and unchanged source, and installs its committed dependencies with
`bun install --frozen-lockfile`. The lock pins `@query-farm/vgi 0.50.0`, RPC 0.29.7
and Arrow 21.1.1. This revision adds composed metadata examples after v0.4.0;
the driver and row decoding are unchanged. No local worker build is required.

`fixture_worker.ts` registers the unchanged `makeWatermarkFunction`, `SPECS` and
`makeCatalog` through the real SDK. Their existing client-factory seam supplies an
HTTP adapter that maps the expected Graph origin to loopback and rejects writes.
The real function builds the ge/le filter, follows opaque pages, extracts fields,
computes its watermark and emits its own Arrow schema. Dummy SQL secret values
satisfy lookup without authentication. No real credentials are read or requests
forwarded to Microsoft.

Native sign-in retrieval, authentication, permissions, licenses, retry behavior,
directory audit retrieval and masking composition are outside this example.
User-principal-name and IP fields are absent from every fixture event, so those
output columns are NULL. No person or account is assessed or changed.

## Focused experiment

```sh
uv run --locked python execute.py --timeout 300 \
  --parameters '{"LAG_MINUTES": 0}' --output-dir artifacts/zero-lag
```

Default **10 minutes**; accepted integers **0–20**. Predict that zero lag leaves the
sink unique but misses late events older than the first maximum timestamp. Compare
the resume boundary, missing-event table and known-outcome denominator. Application
checks should still pass: they validate what was delivered, not completeness.
Reset to **10** for the default.

The experiment includes the guide, runner, launcher, fixture, helper, environment
lock and branding assets. Generated source caches, logs, figures and experiments
are ignored. Failed executions preserve the last successful default notebook.

## Fixture and cursor semantics

`synthetic_signins_api.py` implements the paged sign-in endpoint on loopback.
Its envelope and inclusive ge/le semantics follow `test/fake-signins.ts` in the
pinned MIT source (Query Farm). Opaque page tokens carry the filtered snapshot,
phase, offset and page size. Unsupported endpoints/filters fail explicitly with
no live fallback. Each page contains at most three events. The request trace
checks that each of the three materialized scans starts once.

The first scan covers **4 July 2026, 10:00–10:30 UTC**, both endpoints inclusive.
The second resumes at the first marker and ends at **10:45 UTC**, inclusive. The
first response is deliberately unordered. Afterwards, events timestamped 10:23
and 10:27 become visible, along with newer events at 10:35 and 10:40. Existing
payloads remain immutable. All names, IDs, status codes and dates are invented.
One initial status is missing and remains unknown in every representation.

The real driver computes `max(since, min(max_seen, now) - lag)`. The fixture requires
an execution clock after its historical window, so `max_seen` is below `now`.
At zero lag, `ge max_seen` still re-reads the boundary event but provides no
lookback duration. A strict marker has no business fields. These bounded cursors
belong to a separate replay; they are never persisted as live ingestion state.

The local primary key is ID within one synthetic feed. A multi-tenant, multi-feed
sink must include that scope. Before `ON CONFLICT DO NOTHING`, the notebook checks
that repeated payloads are unchanged; corrections would require another strategy.
Data and replay cursor are updated in order in memory, not through a durable
transaction. Production must commit both atomically on one transactional connection.
Ten minutes captures these late events without guaranteeing coverage of all delays.

For sign-ins, status code 0 is success, positive integer is failure, and missing,
invalid or negative status is unknown. The rate denominator includes only known
outcomes. Directory audit strings have different semantics and are not mixed in.
A measured failure percentage is not a security score or evidence about an identity.

## Validation and upgrades

The source suite passes **7 Bun tests, 22 expectations**, and own-source TypeScript
checking. The CI-prescribed vgi-lint 2.5.1 check reports **100/100, L1 structural
assurance, zero findings**; it intentionally does not execute credentialed examples.
The notebook separately checks seven SQL relationships, repeated-payload safety,
outcome partitioning, pagination and the local request contract.

To upgrade, change the explicit release/revision pins, inspect the remote lock,
rerun both parameter sets and review figures before replacing successful outputs.
The community VGI extension is downloaded independently of the Python lock.
The unchanged local Strata Sun and VGI marks link to Query.Farm and VGI.

## SQL credential isolation

The notebook creates Haybarn with a fresh temporary `secret_directory` and
`allow_persistent_secrets=False` before attaching workers. It fully drains and
checks an empty secret inventory, then creates only explicitly `TEMPORARY`
public fixture secrets and verifies their `persistent=false`, `storage=memory`
metadata. Cleanup removes the temporary directory after closing the connection.
Existing user SQL secrets are neither read, modified nor deleted.
