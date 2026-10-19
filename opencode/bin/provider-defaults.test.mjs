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

  for (const [name, model] of Object.entries(openai.models)) {
    assert.deepEqual(model.limit, { context: 272000, input: 272000, output: 128000 }, name)
    for (const [variant, options] of Object.entries(model.variants ?? {})) {
      assert.equal(Object.hasOwn(options, "textVerbosity"), false, `${name}/${variant}`)
      assert.equal(Object.hasOwn(options, "reasoningSummary"), false, `${name}/${variant}`)
      assert.equal(options.reasoningEffort, expectedEfforts[variant], `${name}/${variant}`)
    }
  }
})
