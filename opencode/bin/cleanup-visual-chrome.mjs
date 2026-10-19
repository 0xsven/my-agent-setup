#!/usr/bin/env node
import { execFileSync } from "node:child_process"

const WAIT_MS = 750

export function nearestOpenCodeAncestor(processes, callerPID) {
  const byPID = new Map(processes.map((process) => [process.pid, process]))
  let current = byPID.get(callerPID)
  const visited = new Set()

  while (current && !visited.has(current.pid)) {
    if (isOpenCode(current)) return current
    visited.add(current.pid)
    current = byPID.get(current.ppid)
  }

  return null
}

export function ownedVisualChrome(processes, callerPID) {
  const owner = nearestOpenCodeAncestor(processes, callerPID)
  if (!owner) return { owner: null, mcps: [], chromeRoots: [], targets: [] }

  const children = childrenByParent(processes)
  const ownerDescendants = descendantsOf([owner.pid], children)
  const mcps = processes.filter((process) => ownerDescendants.has(process.pid) && isChromeDevtoolsMcp(process))
  const mcpDescendants = descendantsOf(mcps.map((process) => process.pid), children)
  const chromeRoots = processes.filter((process) => {
    if (!mcpDescendants.has(process.pid) || !isChromeMainProcess(process)) return false
    return !hasAncestor(process, processes, (ancestor) => isChromeMainProcess(ancestor) && mcpDescendants.has(ancestor.pid))
  })
  const targets = processes.filter((process) => chromeRoots.some((root) => root.pid === process.pid || isDescendantOf(process.pid, root.pid, children)))

  return { owner, mcps, chromeRoots, targets }
}

export async function forceCleanup({ snapshot = processSnapshot, signal = process.kill, wait = delay, callerPID = process.pid } = {}) {
  const initial = ownedVisualChrome(snapshot(), callerPID)
  if (!initial.owner || initial.targets.length === 0) return summary(initial, "dry-run")

  const term = []
  for (const target of initial.targets) {
    try {
      signal(target.pid, "SIGTERM")
      term.push(target.pid)
    } catch (error) {
      if (error.code !== "ESRCH") throw error
    }
  }
  await wait(WAIT_MS)

  const current = new Map(snapshot().map((candidate) => [candidate.pid, candidate]))
  const survivors = initial.targets.filter((target) => sameProcess(target, current.get(target.pid)))
  const killed = []
  for (const target of survivors) {
    try {
      signal(target.pid, "SIGKILL")
      killed.push(target.pid)
    } catch (error) {
      if (error.code !== "ESRCH") throw error
    }
  }
  return summary(initial, "cleanup", term, killed, survivors.map((target) => target.pid))
}

function childrenByParent(processes) {
  const children = new Map()
  for (const process of processes) {
    const list = children.get(process.ppid) ?? []
    list.push(process.pid)
    children.set(process.ppid, list)
  }
  return children
}

function descendantsOf(roots, children) {
  const descendants = new Set()
  const pending = [...roots]
  while (pending.length) {
    const pid = pending.pop()
    for (const child of children.get(pid) ?? []) {
      if (!descendants.has(child)) {
        descendants.add(child)
        pending.push(child)
      }
    }
  }
  return descendants
}

function isDescendantOf(pid, rootPID, children) {
  return descendantsOf([rootPID], children).has(pid)
}

function hasAncestor(process, processes, predicate) {
  const byPID = new Map(processes.map((candidate) => [candidate.pid, candidate]))
  let current = byPID.get(process.ppid)
  const visited = new Set()
  while (current && !visited.has(current.pid)) {
    if (predicate(current)) return true
    visited.add(current.pid)
    current = byPID.get(current.ppid)
  }
  return false
}

function isOpenCode(process) {
  return /(^|[/\s])opencode(?:\s|$)/i.test(`${process.command} ${process.args}`)
}

function isChromeDevtoolsMcp(process) {
  return /(^|[/\s])chrome-devtools-mcp(?:@[^/\s]+)?(?:\s|$)/i.test(`${process.command} ${process.args}`)
}

function isChromeMainProcess(process) {
  return /(?:^|\/)(?:Google Chrome(?: (?:Beta|Canary|Dev))?|Chromium|chrome)$/i.test(process.command)
}

function processSnapshot() {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,lstart=,comm=,args="], { encoding: "utf8" })
  return output.split("\n").map(parseProcess).filter(Boolean)
}

function parseProcess(line) {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s*(.*)$/)
  if (!match) return null
  return { pid: Number(match[1]), ppid: Number(match[2]), started: match[3].trim(), command: match[4], args: match[5] }
}

function sameProcess(process, current) {
  return current && current.started === process.started && isChromeProcess(current)
}

function isChromeProcess(process) {
  return /(?:^|\/)(?:Google Chrome(?: (?:Beta|Canary|Dev| Helper(?: \(.+\))?))?|Chromium|chrome)$/i.test(process.command)
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function summary({ owner, mcps, chromeRoots, targets }, mode, term = [], killed = [], survivors = []) {
  return {
    mode,
    owner: owner ? { pid: owner.pid } : null,
    mcpPids: mcps.map((process) => process.pid),
    chromeRootPids: chromeRoots.map((process) => process.pid),
    targetPids: targets.map((process) => process.pid),
    termPids: term,
    killPids: killed,
    termSurvivorPids: survivors,
  }
}

function print(result, json) {
  if (json) return console.log(JSON.stringify(result))
  if (!result.owner) return console.log("No current OpenCode ancestor; no processes considered.")
  console.log(`${result.mode}: OpenCode ${result.owner.pid}; MCPs [${result.mcpPids.join(", ")}]; Chrome targets [${result.targetPids.join(", ")}].`)
  if (result.mode === "cleanup") console.log(`TERM [${result.termPids.join(", ")}]; KILL [${result.killPids.join(", ")}]; TERM survivors [${result.termSurvivorPids.join(", ")}].`)
}

async function main() {
  const args = new Set(process.argv.slice(2))
  if ([...args].some((arg) => !["--force", "--json"].includes(arg))) throw new Error("Usage: cleanup-visual-chrome.mjs [--force] [--json]")

  const initial = ownedVisualChrome(processSnapshot(), process.pid)
  if (!args.has("--force") || !initial.owner || initial.targets.length === 0) {
    print(summary(initial, "dry-run"), args.has("--json"))
    return
  }

  print(await forceCleanup(), args.has("--json"))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
