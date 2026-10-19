import assert from "node:assert/strict"
import test from "node:test"
import plugin, { rewriteInput } from "../plugins/rtk.ts"

test("V2 RTK plugin declares its stable identity and setup", () => {
  assert.equal(plugin.id, "local.rtk")
  assert.equal(typeof plugin.setup, "function")
})

test("RTK passes the original command as one argument and applies a valid rewrite", async () => {
  const input = { command: "git status --short" }
  await rewriteInput(input, async (binary, args) => {
    assert.equal(binary, "rtk")
    assert.deepEqual(args, ["rewrite", "git status --short"])
    return { stdout: "rtk git status --short\n" }
  })
  assert.equal(input.command, "rtk git status --short")
})

test("RTK leaves missing, unchanged, and failed rewrites untouched", async () => {
  let calls = 0
  await rewriteInput({ command: undefined }, async () => { calls++ })
  assert.equal(calls, 0)
  const unchanged = { command: "date" }
  await rewriteInput(unchanged, async () => ({ stdout: "date\n" }))
  assert.equal(unchanged.command, "date")
  await rewriteInput(unchanged, async () => { throw new Error("rtk unavailable") })
  assert.equal(unchanged.command, "date")
})
