import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const config = JSON.parse(readFileSync(new URL("../opencode.json", import.meta.url), "utf8"))

test("compaction selects GPT-6.1 Sol/medium without replacing the native prompt or permissions", () => {
  assert.deepEqual(config.agent.compaction, {
    model: "openai/gpt-6.1-sol",
    variant: "medium",
    options: { reasoningEffort: "medium" },
  })
  assert.equal(config.default_agent, "plan")
  assert.equal(Object.hasOwn(config.agent.plan, "prompt"), false)
  assert.equal(Object.hasOwn(config.agent.plan, "model"), false)
})

test("automatic compaction preserves a 15k recent tail without changing pruning or turn limits", () => {
  assert.deepEqual(config.compaction, {
    auto: true,
    buffer: 32000,
    keep: { tokens: 15000 },
  })
})

test("every configured model has the 272k context/input cap and a 240k compaction threshold", () => {
  const models = Object.entries(config.provider).flatMap(([provider, config]) =>
    Object.entries(config.models ?? {}).map(([name, model]) => [`${provider}/${name}`, model]))
  assert.equal(models.length, 15)
  for (const [name, model] of models) {
    const expectedLimit = { context: 272000, input: 272000, output: 128000 }
    const expectedThreshold = expectedLimit.input - config.compaction.buffer
    assert.equal(expectedThreshold, 240000, name)
    assert.deepEqual(model.limit, expectedLimit, name)

    // Simulate an inherited upstream catalog limit to verify the explicit override.
    const catalog = { context: 1050000, input: 922000, output: 128000 }
    const resolved = { ...catalog, ...model.limit }
    const threshold = Math.max(0, resolved.input - config.compaction.buffer)
    assert.equal(threshold, expectedThreshold, name)
    assert.equal(expectedThreshold - 1 >= threshold, false, name)
    assert.equal(expectedThreshold >= threshold, true, name)
  }
})
