#!/usr/bin/env node
import { cp, lstat, mkdir, readFile, readlink, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

export const MANAGED_TARGETS = [
  "opencode.json",
  "AGENTS.md",
  "agents",
  "commands",
  "plugins",
  "bin",
]

const repoRoot = resolve(import.meta.dirname, "..")
const sourceRoot = join(repoRoot, "opencode")
const RETIRED_TARGETS = [
  { entry: "skills/context-mode-research", source: join(sourceRoot, "skills/context-mode-research") },
  { entry: "node_modules/context-mode", source: join(repoRoot, "node_modules/context-mode") },
]

export function defaultTarget(environment = process.env) {
  return join(environment.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
}

export function planTargets(target, source = sourceRoot) {
  return MANAGED_TARGETS.map((entry) => ({
    entry,
    source: join(source, entry),
    destination: join(target, entry),
  }))
}

async function entryKind(path) {
  try {
    return (await lstat(path)).isSymbolicLink() ? "symlink" : "other"
  } catch (error) {
    if (error.code === "ENOENT") return "missing"
    throw error
  }
}

export async function pointsTo(path, source) {
  if (await entryKind(path) !== "symlink") return false
  return resolve(dirname(path), await readlink(path)) === resolve(source)
}

export async function install(target, { yes = false, dryRun = false, now = new Date(), backupRoot = join(homedir(), ".local", "state", "opencode-setup", "backups") } = {}) {
  const entries = planTargets(target)
  const changes = []
  for (const entry of entries) {
    const kind = await entryKind(entry.destination)
    const owned = kind === "symlink" && await pointsTo(entry.destination, entry.source)
    if (!owned) changes.push({ ...entry, kind })
  }
  const retired = []
  for (const entry of RETIRED_TARGETS) {
    const destination = join(target, entry.entry)
    if (await pointsTo(destination, entry.source)) retired.push({ ...entry, destination })
  }
  if ((changes.length || retired.length) && !yes && !dryRun) throw new Error("Refusing to change targets without --yes. Review --dry-run first.")
  const stamp = now.toISOString().replace(/[:.]/g, "-")
  const backup = join(backupRoot, stamp)
  if (dryRun) return { action: "install", target, backup, changes: [...changes.map(({ entry, kind }) => `${entry}: ${kind}`), ...retired.map(({ entry }) => `${entry}: retire owned symlink`)] }
  if (!changes.length && !retired.length) return { action: "install", target, backup: undefined, changes: [], moved: [] }

  const moved = []
  const created = []
  for (const entry of changes) {
    await mkdir(dirname(entry.destination), { recursive: true })
    if (entry.kind !== "missing") {
      const saved = join(backup, entry.entry)
      await mkdir(dirname(saved), { recursive: true })
      await rename(entry.destination, saved)
      moved.push(entry.entry)
    } else created.push(entry.entry)
    await symlink(entry.source, entry.destination)
  }
  for (const entry of retired) {
    // Recheck immediately before unlinking; never remove a replacement or real directory.
    if (await pointsTo(entry.destination, entry.source)) await rm(entry.destination)
  }
  await mkdir(backup, { recursive: true })
  await writeFile(join(backup, "manifest.json"), `${JSON.stringify({ target, moved, created, managed: MANAGED_TARGETS, retired: retired.map(({ entry, source }) => ({ entry, source })) }, null, 2)}\n`)
  return { action: "install", target, backup, changes: [...changes.map(({ entry }) => entry), ...retired.map(({ entry }) => entry)], moved }
}

export async function restore(target, { yes = false, dryRun = false, backup } = {}) {
  const selected = backup || await latestBackup()
  if (!selected) throw new Error("No installer backup is available to restore.")
  const manifest = JSON.parse(await readFile(join(selected, "manifest.json"), "utf8"))
  if (resolve(manifest.target) !== resolve(target)) throw new Error("Backup belongs to a different target directory.")
  // Older manifests have only `moved` and `managed`. Their installed-but-not-
  // moved links are ambiguous, so leave those links in place rather than deleting them.
  const moved = new Set(manifest.moved || [])
  const created = new Set(manifest.created || [])
  const retired = new Map((manifest.retired || []).map((value) =>
    typeof value === "string" ? [value, undefined] : [value.entry, value.source]))
  const known = [...planTargets(target), ...RETIRED_TARGETS.map((entry) => ({ ...entry, destination: join(target, entry.entry) }))]
  const allowed = new Map(known.map((entry) => [entry.entry, entry]))
  for (const entry of [...moved, ...created, ...retired.keys()]) {
    if (!allowed.has(entry)) throw new Error(`Unknown backup target: ${entry}`)
  }
  const changes = []
  for (const entry of known) {
    const restoreBackup = moved.has(entry.entry)
    const removeCreated = created.has(entry.entry)
    const restoreRetired = retired.has(entry.entry)
    if (!restoreBackup && !removeCreated && !restoreRetired) continue
    if (restoreRetired && retired.get(entry.entry) && resolve(retired.get(entry.entry)) !== resolve(entry.source)) {
      throw new Error(`Retired target has an unexpected source: ${entry.entry}`)
    }
    const kind = await entryKind(entry.destination)
    if (kind !== "missing" && !(kind === "symlink" && await pointsTo(entry.destination, entry.source))) {
      throw new Error(`Refusing to restore over unmanaged target: ${entry.entry}`)
    }
    if (restoreBackup && await entryKind(join(selected, entry.entry)) === "missing") {
      throw new Error(`Backup target is missing: ${entry.entry}`)
    }
    if (restoreBackup || (removeCreated && kind !== "missing") || (restoreRetired && kind === "missing")) {
      changes.push({ ...entry, restoreBackup, removeCreated, restoreRetired })
    }
  }
  if (dryRun) return { action: "restore", target, backup: selected, changes: changes.map(({ entry }) => entry) }
  if (changes.length && !yes) throw new Error("Refusing to alter managed targets without --yes.")
  for (const entry of changes) {
    const kind = await entryKind(entry.destination)
    if (kind !== "missing" && !await pointsTo(entry.destination, entry.source)) {
      throw new Error(`Refusing to restore over unmanaged target: ${entry.entry}`)
    }
    if (kind !== "missing" && (entry.restoreBackup || entry.removeCreated)) await rm(entry.destination)
    const saved = join(selected, entry.entry)
    if (entry.restoreBackup) {
      await mkdir(dirname(entry.destination), { recursive: true })
      await cp(saved, entry.destination, { recursive: true, force: false })
    } else if (entry.restoreRetired && kind === "missing") {
      await mkdir(dirname(entry.destination), { recursive: true })
      await symlink(entry.source, entry.destination)
    }
  }
  return { action: "restore", target, backup: selected, changes: changes.map(({ entry }) => entry) }
}

async function latestBackup() {
  const base = join(homedir(), ".local", "state", "opencode-setup", "backups")
  try {
    const names = (await readdir(base)).sort().reverse()
    return names.length ? join(base, names[0]) : undefined
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }
}

function parseArgs(args) {
  const options = { dryRun: false, install: false, restore: false, yes: false, target: defaultTarget() }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--dry-run") options.dryRun = true
    else if (argument === "--install") options.install = true
    else if (argument === "--uninstall" || argument === "--restore") options.restore = true
    else if (argument === "--yes") options.yes = true
    else if (argument === "--target") options.target = args[++index]
    else if (argument === "--help") return null
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!isAbsolute(options.target)) throw new Error("--target must be an absolute path.")
  if (options.install === options.restore) throw new Error("Choose exactly one of --install or --uninstall/--restore.")
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options) {
    console.log("Usage: install.mjs (--install | --uninstall) [--dry-run] [--yes] [--target /absolute/path]")
    return
  }
  const result = options.install
    ? await install(options.target, options)
    : await restore(options.target, options)
  console.log(`${result.action}: ${result.changes.length} managed target(s) ${options.dryRun ? "would change" : "changed"}.`)
  console.log(`Target: ${result.target}`)
  console.log(`Backup: ${result.backup || "none (already installed)"}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
