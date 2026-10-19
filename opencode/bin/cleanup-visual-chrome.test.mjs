import assert from "node:assert/strict"
import test from "node:test"
import { forceCleanup, ownedVisualChrome } from "./cleanup-visual-chrome.mjs"

function process(pid, ppid, command, args = "") {
  return { pid, ppid, command, args, started: "fixture" }
}

test("selects only Chrome descended from the caller's OpenCode-owned MCP", () => {
  const tree = [
    process(1, 0, "/sbin/launchd"),
    process(10, 1, "/usr/local/bin/opencode", "opencode"),
    process(11, 10, "/bin/zsh"),
    process(12, 11, "/usr/local/bin/node", "cleanup-visual-chrome.mjs"),
    process(20, 10, "/usr/local/bin/node", "chrome-devtools-mcp@latest --isolated=true"),
    process(21, 20, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    process(22, 21, "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer)"),
    process(30, 1, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ]
  const result = ownedVisualChrome(tree, 12)
  assert.equal(result.owner.pid, 10)
  assert.deepEqual(result.mcps.map(({ pid }) => pid), [20])
  assert.deepEqual(result.chromeRoots.map(({ pid }) => pid), [21])
  assert.deepEqual(result.targets.map(({ pid }) => pid), [21, 22])
})

test("excludes a second OpenCode instance and its test Chrome", () => {
  const tree = [
    process(1, 0, "/sbin/launchd"),
    process(10, 1, "/usr/local/bin/opencode", "opencode"),
    process(12, 10, "/usr/local/bin/node", "cleanup-visual-chrome.mjs"),
    process(20, 10, "/usr/local/bin/node", "chrome-devtools-mcp@latest"),
    process(21, 20, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    process(40, 1, "/usr/local/bin/opencode", "opencode"),
    process(50, 40, "/usr/local/bin/node", "chrome-devtools-mcp@latest"),
    process(51, 50, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ]
  assert.deepEqual(ownedVisualChrome(tree, 12).targets.map(({ pid }) => pid), [21])
})

test("does nothing when the caller has no OpenCode ancestor", () => {
  const tree = [
    process(1, 0, "/sbin/launchd"),
    process(12, 1, "/usr/local/bin/node", "cleanup-visual-chrome.mjs"),
    process(20, 1, "/usr/local/bin/node", "chrome-devtools-mcp@latest"),
    process(21, 20, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ]
  assert.deepEqual(ownedVisualChrome(tree, 12), { owner: null, mcps: [], chromeRoots: [], targets: [] })
})

test("force cleanup sends TERM, rechecks ownership, then KILLs only unchanged survivors", async () => {
  const initial = [
    process(1, 0, "/sbin/launchd"),
    process(10, 1, "/usr/local/bin/opencode", "opencode"),
    process(12, 10, "/usr/local/bin/node", "cleanup-visual-chrome.mjs"),
    process(20, 10, "/usr/local/bin/node", "chrome-devtools-mcp@latest"),
    process(21, 20, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    process(22, 21, "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer)"),
  ]
  const current = initial.filter(({ pid }) => pid !== 21).map((entry) => entry.pid === 22 ? { ...entry, started: "reused-pid" } : entry)
  const signals = []
  const result = await forceCleanup({
    callerPID: 12,
    snapshot: (() => { let calls = 0; return () => ++calls === 1 ? initial : current })(),
    signal: (pid, signal) => signals.push([pid, signal]),
    wait: async () => {},
  })
  assert.deepEqual(signals, [[21, "SIGTERM"], [22, "SIGTERM"]])
  assert.deepEqual(result.termPids, [21, 22])
  assert.deepEqual(result.termSurvivorPids, [])
  assert.deepEqual(result.killPids, [])
})

test("force cleanup KILLs an unchanged still-owned Chrome process only", async () => {
  const tree = [
    process(1, 0, "/sbin/launchd"), process(10, 1, "/usr/local/bin/opencode", "opencode"),
    process(12, 10, "/usr/local/bin/node", "cleanup-visual-chrome.mjs"),
    process(20, 10, "/usr/local/bin/node", "chrome-devtools-mcp@latest"),
    process(21, 20, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ]
  const signals = []
  const result = await forceCleanup({ callerPID: 12, snapshot: () => tree, signal: (pid, signal) => signals.push([pid, signal]), wait: async () => {} })
  assert.deepEqual(signals, [[21, "SIGTERM"], [21, "SIGKILL"]])
  assert.deepEqual(result.termSurvivorPids, [21])
  assert.deepEqual(result.killPids, [21])
})
