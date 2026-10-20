import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const config = JSON.parse(readFileSync(new URL("../opencode.json", import.meta.url), "utf8"))
const openai = config.provider.openai
const expectedEfforts = {
  none: "none",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
}

test("OpenAI defaults and every configured variant inherit them", () => {
  assert.deepEqual(openai.options, {
    reasoningEffort: "medium",
    reasoningSummary: "auto",
    textVerbosity: "low",
    include: ["reasoning.encrypted_content"],
    store: false,
  })
  assert.equal(config.model, "openai/gpt-6.1-sol")
  assert.deepEqual(Object.keys(openai.models).sort(), ["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"])

  for (const [name, model] of Object.entries(openai.models)) {
    assert.deepEqual(model.limit, { context: 272000, input: 272000, output: 128000 }, name)
    assert.deepEqual(model.modalities, { input: ["text", "image"], output: ["text"] }, name)
    const efforts = name === "gpt-6-astra" ? Object.keys(expectedEfforts).filter((id) => id !== "max") : Object.keys(expectedEfforts)
    assert.deepEqual(Object.keys(model.variants), efforts, name)
    for (const [variant, options] of Object.entries(model.variants)) {
      assert.equal(Object.hasOwn(options, "textVerbosity"), false, `${name}/${variant}`)
      assert.equal(Object.hasOwn(options, "reasoningSummary"), false, `${name}/${variant}`)
      assert.equal(options.reasoningEffort, expectedEfforts[variant], `${name}/${variant}`)
    }
  }
})
