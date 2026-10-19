---
name: context-mode-research
description: Research external docs and survey codebase usage at scale using context-mode tools without flooding context. Use when asked to research a library or topic, census or survey pattern usage across a codebase, gather API documentation, or answer "how is X used" questions spanning many files.
---

# Context-Mode Research

Measured in a controlled experiment (Aug 2026, 222-file library survey in a large TS monorepo): ~3x less context and ~1.6x cheaper than raw `Read`/`Grep`/`webfetch` at equal answer depth — but only if the depth rules below are followed.

## 1) Tool routing

- Docs/web: `ctx_fetch_and_index` (batch URLs, `concurrency` 3-8), then `ctx_search` with 2-4 specific technical terms per query, all questions batched in one call.
- Census/counts: `ctx_batch_execute` (descriptive `label` per command, pass `queries` for inline answers) or `ctx_execute` with javascript for aggregation.
  - Avoid shell `for` loops in `ctx_batch_execute` on macOS — they hit zsh parse errors. Iterate inside `ctx_execute` JS instead.
  - The Node sandbox is CommonJS: use `require`, not `import`.
- File-level depth: `ctx_execute_file` to derive and print only what matters, or `ctx_index(path)` + `ctx_search` when content must stay queryable.
- Raw `Read`/`Grep`/`webfetch` only when preparing edits (Edit needs exact bytes in context) or for a single known-location lookup.

## 2) Match depth to the question

- Counts and tallies answer "how many / where distributed". They do NOT answer "how / why".
- For pattern questions, ingest 5-10 representative full files via `ctx_execute_file`/`ctx_index` before concluding. (In the experiment, counts-only answers missed provider wiring and `ref()` usage details that file ingestion caught.)

## 3) Census methodology

- Prefer import-line greps over word counts: `grep -rh "from '<pkg>" ... | sort | uniq -c`, then tally identifiers from those lines.
- Word-match counts (`grep -rlw derive`) hit comments, local identifiers, and unrelated APIs — they overstate badly (measured: 61 word-hits vs 0 actual imports).

## 4) Verification

- An empty ctx result is not evidence of absence: silent ingestion failures happen — confirm the path exists before claiming "unused" or "missing".
- Ground-truth any surprising claim with one direct grep before reporting it.
- When two sources disagree, adjudicate with a direct check, not reasoning.
