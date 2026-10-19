# Agent activity report

Run the standalone `agent-usage.mjs` CLI for work overviews and usage tables.

The CLI reads V2's projected session/message API via `opencode api get`
(using the CLI's service discovery and authentication) and prints the report
directly, without model calls.

The report shows:

- The latest non-reporting work run, observed actions, and bounded response text.
- Each task's purpose, agent/model, worker linkage, new/resumed status, and outcome.
- Recognized verification operations with recorded status and exit evidence.
- Separate latest-run and full-session-to-cutoff token/cost tables, attributed
  from assistant messages rather than mutable session totals.

Reporting activity, its worker descendants, and native synthetic
summaries are excluded. Task completion is not proof that implementation is
correct. Unknown verification results and missing linkage remain unknown.
Prior reporting turns are excluded from later reports by their command marker.

## Session selection

By default, the CLI selects the most recently updated root session in the current
directory and labels this fallback. If multiple sessions share a directory, check
the reported root ID. Select a specific session with `--session`:

```sh
node --no-warnings ~/.config/opencode/bin/agent-usage.mjs --session <root-session-id>
```

For historical **V1** reporting, pass `--legacy-db` (and optionally `--session`).
This reads the old SQLite schema in read-only mode; `OPENCODE_DB_PATH` can point
to a backed-up V1 database. Its default respects `XDG_DATA_HOME`, falling back to
`~/.local/share/opencode/opencode.db`. The default V2 path never interprets the
database as V1. For V2, `opencode api` may start the shared background service.
If API access or pagination fails, the command exits with an error rather than
showing partial or incorrectly attributed totals.
Message requests use five-item pages because the V2 CLI can exit successfully
after truncating a large JSON response. A single exceptionally large projected
message may still exceed what the CLI prints; in that case JSON parsing fails
closed rather than producing a partial report.
V2 reporting also stops explicitly at 16 MiB of projected API data, 2,000
messages, or 256 sessions across the selected tree. These limits prevent an
unbounded transcript or tool output from accumulating in memory; use a smaller
session if one is exceeded. V1 database reporting retains its historical behavior.

## Limits and safety

Recorded `$0` cost is not zero ChatGPT allowance consumption. Context-isolation
figures compare tool-output bytes; they are not measured token or quota savings.
Verification detection covers selected shell operations, not arbitrary tools.
V2 task-worker linkage depends on recorded task IDs; missing linkage stays unknown.
Raw shell arguments and tool outputs are omitted; bounded
free text is escaped and common credential forms are redacted. This is not a
comprehensive secret scanner. The former slash command sent the report through
the configured model provider; the standalone CLI does not.

## Validation

From this OpenCode configuration directory:

```sh
node --check bin/agent-usage.mjs
node --check bin/reporting.mjs
node --test bin/reporting.test.mjs
```

Tests use disposable SQLite fixtures and stubbed V2 API pages; they do not mutate
the live OpenCode database. Run the standalone Node command above to smoke-test;
`--reporting` exercises the report-boundary behavior used by the former command.

## Visual Chrome cleanup

After final Visual QA, Build runs the ownership-scoped cleanup helper:

```sh
node --no-warnings ~/.config/opencode/bin/cleanup-visual-chrome.mjs --force
```

It finds the nearest `opencode` ancestor of the helper, then only Chrome trees
descended from `chrome-devtools-mcp` processes below that OpenCode instance.
It never targets normal Chrome or another OpenCode session. The default is a
dry run; use `--json` for a machine-readable PID-only summary. `--force` sends
`TERM`, waits briefly, then sends `KILL` only to still-identical owned Chrome
processes. It does not print process arguments.
