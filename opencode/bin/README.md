# Visual Chrome cleanup

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
