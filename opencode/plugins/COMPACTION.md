# Compaction policy

Configured in `../opencode.json`:

- The hidden stock `compaction` agent is configured with `openai/gpt-6.1-sol`
  and the `medium` variant.
- Its intended reasoning effort is `medium`.
- All three configured OpenAI models explicitly declare `context: 272000` and
  `input: 272000`: GPT-6.1 Sol, GPT-6 Luna, and GPT-6 Astra. These are
  deliberate local caps, not the models' native capacities. Output limits remain `128000`.
- Automatic compaction uses a 32,000-token buffer. The configured
  `limit.input - 32000` gives a trigger of approximately 240,000
  reported tokens for every configured model. This is an automatic-compaction threshold, not a hard request
  truncation mechanism: a large tool result or request can still overshoot it.
- Up to 15,000 tokens of recent conversation are retained. The native
  summary prompt, tail selection, and pruning default are otherwise unchanged.

The shared configuration uses `provider`, `agent`, `reserved`, and
`preserve_recent_tokens` so Desktop's V1 sidecar and the V2 CLI both apply it.
V2 migrates these supported fields to its native representation.

The explicit input limits prevent inherited catalog values (notably Astra's)
from bypassing the intended context policy. Newly added models or project-level
overrides must also be checked; this policy does not globally cap every model in
OpenCode's catalog.

## Reasoning guard

Both engines auto-discover `compaction-reasoning.ts` in the installed global
`plugins/` directory. No explicit plugin file registration is needed.

The plugin exposes a V1 `server()` entrypoint and a V2 `setup()` entrypoint.
V1 uses `chat.params` only for the OpenAI `compaction` agent; V2 uses its
provider-scoped `session.compaction` hook. Both set only the request's
`reasoningEffort` to `medium`, leaving ordinary agents' reasoning levels and
other request parameters unchanged.

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
