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
