# Global Agent Instructions

## Research and verification

- Use the available file-search, read, and web tools for research. Read source directly before editing it.
- Verify surprising claims against source; an empty or failed lookup is not evidence of absence.

## Scope and simplicity

- Build the requested outcome and its necessary integration, not additional features. When material product decisions are unspecified, especially in a new project, ask rather than invent them. Use established context and patterns for routine engineering choices; do not repeatedly seek approval for agreed work.
- Prefer the smallest complete, readable change. Reuse existing code and dependencies; avoid speculative abstractions, options, compatibility layers, unrelated cleanup, and new tooling without a demonstrated need. Include affected callers and contracts. Do not split files merely to shorten them or omit necessary work to meet a line/file quota.
- When a missing or broken upstream contract would require substantial workaround logic, do bounded investigation, explain the gap and smallest upstream fix, and ask before building the workaround or expanding into another system. Workers report this decision to the parent. Normal documented async flows, conflict handling, and lifecycle safety are not automatically workarounds.
- Preserve required security, trust-boundary validation, accessibility, and data-loss protections. Simplicity is not permission to weaken correctness or silently change agreed behavior or designs to satisfy a tool's score.

## Meaningful verification

- Do not add tests by default. Routine UI changes, component wiring, straightforward refactors, and simple fixes usually need only relevant existing checks.
- Add a focused test when explicitly requested or when it provides substantial protection against an identified risk, such as tricky state interactions, a recurring regression, or consequential security/data-integrity failures. Logic, a branch, or a bug fix alone does not justify a new test.
- Prefer extending an existing test over creating another suite or elaborate fixtures. Avoid implementation-mirroring assertions and duplicate cases; exact values remain appropriate for genuine external compatibility or safety contracts. Do not introduce a test framework solely to verify a trivial change. Preserve useful existing coverage, run appropriate checks, and report verification limits honestly.
