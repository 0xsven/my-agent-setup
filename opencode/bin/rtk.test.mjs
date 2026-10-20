import assert from "node:assert/strict"
import test, { mock } from "node:test"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { promisify } from "node:util"

// Capture an in-memory executor at import time; never invoke the installed RTK.
let execute
const execFile = childProcess.execFile
childProcess.execFile = (binary, args, callback) => {
  Promise.resolve().then(() => execute(binary, args)).then(
    (stdout) => callback(null, stdout, ""),
    (error) => callback(error),
  )
}
childProcess.execFile[promisify.custom] = async (binary, args) => ({
  stdout: await execute(binary, args), stderr: "",
})
syncBuiltinESMExports()
const { default: plugin, rewriteInput } = await import("../plugins/rtk.ts")
childProcess.execFile = execFile
syncBuiltinESMExports()

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
  await rewriteInput(unchanged, async () => ({ stdout: " \n" }))
  assert.equal(unchanged.command, "date")
  await rewriteInput(unchanged, async () => { throw new Error("rtk unavailable") })
  assert.equal(unchanged.command, "date")
})

test("V1 and V2 RTK hooks rewrite only bash/shell command arguments", async () => {
  const calls = []
  execute = async (binary, args) => {
    assert.equal(binary, "rtk")
    calls.push(args)
    return args[0] === "--version" ? "rtk 0.23.0" : `rtk ${args[1]}\n`
  }
  const hooks = await plugin.server()
  let handler
  await plugin.setup({ tool: { hook: async (name, callback) => {
    assert.equal(name, "execute.before")
    handler = callback
  } } })
  for (const tool of ["bash", "shell", "read"]) {
    const command = "git status --short; printf '%s' 'a b'"
    const args = { command, description: "keep" }
    const input = { command, description: "keep" }
    await hooks["tool.execute.before"]({ tool, args: { command: "wrong input" } }, { args })
    await handler({ tool, input })
    const expected = { command: tool === "read" ? command : `rtk ${command}`, description: "keep" }
    assert.deepEqual(args, expected)
    assert.deepEqual(input, expected)
  }
  assert.deepEqual(calls, [
    ["--version"], ["--version"],
    ...Array.from({ length: 4 }, () => ["rewrite", "git status --short; printf '%s' 'a b'"]),
  ])
})

test("V1 and V2 RTK disable hooks when the binary is unavailable", async () => {
  execute = async () => { throw new Error("ENOENT") }
  const warn = mock.method(console, "warn", () => {})
  try {
    assert.deepEqual(await plugin.server(), {})
    await plugin.setup({ tool: { hook: () => assert.fail("must not register") } })
    assert.equal(warn.mock.callCount(), 2)
  } finally {
    warn.mock.restore()
  }
})
