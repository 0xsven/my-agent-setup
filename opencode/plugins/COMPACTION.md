# Compaction policy

Configured in `../opencode.json`:

- The hidden stock `compaction` agent is configured with `openai/gpt-6.1-sol#medium`.
- Its intended reasoning effort is `medium`.
- All three configured OpenAI models explicitly declare `context: 272000` and
  `input: 272000`: GPT-6.1 Sol, GPT-6 Luna, and GPT-6 Astra. These are
  deliberate local caps, not the models' native capacities. Output limits remain `128000`.
- Automatic compaction uses a 32,000-token buffer. The configured
  `limit.input - compaction.buffer` gives a trigger of approximately 240,000
  reported tokens for every configured model. This is an automatic-compaction threshold, not a hard request
  truncation mechanism: a large tool result or request can still overshoot it.
- Up to 15,000 tokens of recent conversation are retained (`keep.tokens`). The native
  summary prompt, tail selection, and pruning default are otherwise unchanged.

The explicit input limits prevent inherited catalog values (notably Astra's)
from bypassing the intended context policy. Newly added models or project-level
overrides must also be checked; this policy does not globally cap every model in
OpenCode's catalog.

## Reasoning guard

`compaction-reasoning.ts` is registered in `../opencode.json` using a path
relative to that config. OpenCode also discovers global plugin files; its
plugin registry retains one entry per ID.

The plugin registers a provider-scoped V2 `session.compaction` request hook and
sets only `event.options.reasoningEffort` to `medium` for OpenAI checkpoint
summaries. It does not change the parent model, variant, prompt, tools, or
other request parameters.

The hook also covers subagent compaction requests and enforces the effort option,
not just a stored variant label. The configured hidden-agent model override is
preserved, but its runtime precedence over the active context model in automatic
and manual compaction has not been verified. These checks do not establish which
model reaches the provider. Recheck this guard when upgrading OpenCode's
compaction path.

## Checks

Run from the repository root, using Node 22 or later:

```sh
node --test opencode/bin/compaction-reasoning.test.mjs opencode/bin/compaction-settings.test.mjs
```

These tests do not call a model, compact a conversation, or access credentials.
Quit and restart OpenCode after changing the configuration or plugin.
