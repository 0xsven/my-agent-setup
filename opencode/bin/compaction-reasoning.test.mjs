import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../plugins/compaction-reasoning.ts"

const hook = async () => {
  let handler
  let filter
  await plugin.setup({ session: { hook: async (name, callback, options) => {
    assert.equal(name, "compaction")
    handler = callback
    filter = options
  } } })
  assert.deepEqual(filter, { providerID: "openai" })
  return handler
}

const input = () => ({ kind: "compaction", model: { providerID: "openai", id: "gpt-6.1-sol" } })

test("forces medium for OpenAI compaction and preserves existing options", async () => {
  const options = { temperature: 0.2, reasoningEffort: "xhigh", custom: true }
  const event = { ...input(), temperature: 0.1, topP: 0.9, options }
  const result = await hook()

  await result(event)

  assert.equal(event.options, options)
  assert.deepEqual(event, {
    ...input(),
    temperature: 0.1,
    topP: 0.9,
    options: { temperature: 0.2, reasoningEffort: "medium", custom: true },
  })
})

test("overrides inherited reasoning values on the compaction request", async () => {
  const result = await hook()
  for (const reasoningEffort of [undefined, "none", "low", "medium", "high", "xhigh"]) {
    const event = { ...input(), options: reasoningEffort === undefined ? {} : { reasoningEffort } }
    await result(event)
    assert.equal(event.options.reasoningEffort, "medium")
  }
})

test("leaves unrelated compaction metadata and model untouched", async () => {
  const result = await hook()
  const event = { ...input(), options: { reasoningEffort: "xhigh" }, title: "keep", maxTokens: 10 }
  await result(event)
  assert.deepEqual(event, { ...input(), options: { reasoningEffort: "medium" }, title: "keep", maxTokens: 10 })
})

test("V1 chat.params forces medium only for OpenAI compaction", async () => {
  const hooks = await plugin.server()
  for (const reasoningEffort of [undefined, "none", "low", "medium", "high", "xhigh"]) {
    const options = { reasoningEffort, custom: true }
    const output = { options, temperature: 0.2, maxOutputTokens: 100 }
    await hooks["chat.params"]({ agent: "compaction", model: { providerID: "openai" } }, output)
    assert.equal(output.options, options)
    assert.deepEqual(output, {
      options: { reasoningEffort: "medium", custom: true }, temperature: 0.2, maxOutputTokens: 100,
    })
  }
})

test("V1 chat.params preserves other providers' compaction options", async () => {
  const hooks = await plugin.server()
  const output = { options: { reasoningEffort: "high", custom: true } }
  await hooks["chat.params"]({ agent: "compaction", model: { providerID: "anthropic" } }, output)
  assert.deepEqual(output, { options: { reasoningEffort: "high", custom: true } })
})

test("V1 chat.params preserves normal agents' reasoning effort", async () => {
  const hooks = await plugin.server()
  for (const [agent, reasoningEffort] of [["Deep", "xhigh"], ["Astra", "xhigh"], ["Quick", "low"], ["summary", "high"]]) {
    const output = { options: { reasoningEffort } }
    await hooks["chat.params"]({ agent, model: { providerID: "openai" } }, output)
    assert.deepEqual(output, { options: { reasoningEffort } })
  }
})
