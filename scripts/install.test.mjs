import assert from "node:assert/strict"
import { lstat, mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { MANAGED_TARGETS, install, planTargets, pointsTo, restore } from "./install.mjs"

const backupRoot = (target) => join(target, "backups")

test("plans only the explicit public OpenCode targets", () => {
  assert.deepEqual(planTargets("/tmp/opencode").map(({ entry }) => entry), MANAGED_TARGETS)
  assert.equal(MANAGED_TARGETS.includes("node_modules"), false)
  assert.equal(MANAGED_TARGETS.includes("node_modules/context-mode"), false)
  assert.equal(MANAGED_TARGETS.includes("skills/context-mode-research"), false)
  assert.equal(MANAGED_TARGETS.includes("tui.json"), false)
})

test("global config plugin paths resolve through installed symlinks from any working directory", async () => {
  const target = await mkdtemp(join(tmpdir(), "opencode-setup-plugin-paths-"))
  try {
    await install(target, { yes: true, backupRoot: backupRoot(target) })
    const config = JSON.parse(await readFile(join(target, "opencode.json"), "utf8"))
    assert.deepEqual(config.plugins, ["./plugins/compaction-reasoning.ts", "./plugins/rtk.ts"])
    for (const relative of config.plugins) {
      const actual = await realpath(resolve(target, relative))
      const expected = await realpath(resolve(import.meta.dirname, "../opencode", relative))
      assert.equal(actual, expected)
    }
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("retires only repository-owned context-mode links and leaves unrelated files alone", async () => {
  const target = await mkdtemp(join(tmpdir(), "opencode-setup-retire-"))
  await mkdir(join(target, "skills"))
  await mkdir(join(target, "node_modules"))
  const source = resolve(import.meta.dirname, "../opencode/skills/context-mode-research")
  const owned = join(target, "skills/context-mode-research")
  const packageLink = join(target, "node_modules/context-mode")
  const packageSource = resolve(import.meta.dirname, "../node_modules/context-mode")
  const unrelated = join(target, "node_modules/unrelated")
  await symlink(source, owned)
  // This link may be dangling after npm ci removes the old dependency.
  await symlink(packageSource, packageLink)
  await writeFile(unrelated, "user-owned")
  const preview = await install(target, { dryRun: true })
  assert(preview.changes.includes("skills/context-mode-research: retire owned symlink"))
  assert(preview.changes.includes("node_modules/context-mode: retire owned symlink"))
  const installed = await install(target, { yes: true, backupRoot: backupRoot(target) })
  await assert.rejects(lstat(owned), { code: "ENOENT" })
  await assert.rejects(lstat(packageLink), { code: "ENOENT" })
  assert.equal(await readlink(join(target, "plugins")), resolve(import.meta.dirname, "../opencode/plugins"))
  await assert.rejects(readlink(unrelated), { code: "EINVAL" })
  const plan = await restore(target, { backup: installed.backup, dryRun: true })
  assert(plan.changes.includes("skills/context-mode-research"))
  assert(plan.changes.includes("node_modules/context-mode"))
  await restore(target, { backup: installed.backup, yes: true })
  assert.equal(await readlink(owned), source)
  assert.equal(await readlink(packageLink), packageSource)
  await assert.rejects(lstat(join(target, "plugins")), { code: "ENOENT" })
  assert.equal(await readFile(unrelated, "utf8"), "user-owned")
  await rm(target, { recursive: true, force: true })
})

test("reinstall and legacy moved:[] backups never remove previously installed links", async () => {
  const target = await mkdtemp(join(tmpdir(), "opencode-setup-reinstall-"))
  try {
    const first = await install(target, { yes: true, backupRoot: backupRoot(target) })
    const next = await install(target, { yes: true, backupRoot: backupRoot(target), now: new Date("2030-01-01") })
    assert.equal(next.backup, undefined)
    assert.deepEqual(next.changes, [])
    const legacy = join(target, "legacy-backup")
    await mkdir(legacy)
    await writeFile(join(legacy, "manifest.json"), JSON.stringify({ target, moved: [], managed: MANAGED_TARGETS }))
    assert.deepEqual((await restore(target, { backup: legacy, dryRun: true })).changes, [])
    assert.deepEqual((await restore(target, { backup: legacy, yes: true })).changes, [])
    for (const entry of planTargets(target)) assert(await pointsTo(entry.destination, entry.source))
    await restore(target, { backup: first.backup, yes: true })
    for (const entry of planTargets(target)) await assert.rejects(lstat(entry.destination), { code: "ENOENT" })
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("restores retired links from the prior V2 manifest format without removing pre-existing managed links", async () => {
  const target = await mkdtemp(join(tmpdir(), "opencode-setup-legacy-retired-"))
  try {
    const installed = await install(target, { yes: true, backupRoot: backupRoot(target) })
    const oldManifest = join(target, "old-manifest")
    await mkdir(oldManifest)
    await writeFile(join(oldManifest, "manifest.json"), JSON.stringify({
      target,
      moved: [],
      managed: MANAGED_TARGETS,
      retired: ["skills/context-mode-research", "node_modules/context-mode"],
    }))
    const result = await restore(target, { backup: oldManifest, yes: true })
    assert.deepEqual(result.changes, ["skills/context-mode-research", "node_modules/context-mode"])
    for (const entry of planTargets(target)) assert(await pointsTo(entry.destination, entry.source))
    assert(await pointsTo(join(target, "skills/context-mode-research"), resolve(import.meta.dirname, "../opencode/skills/context-mode-research")))
    assert(await pointsTo(join(target, "node_modules/context-mode"), resolve(import.meta.dirname, "../node_modules/context-mode")))
    const manifest = JSON.parse(await readFile(join(installed.backup, "manifest.json"), "utf8"))
    assert.equal(manifest.created.length, MANAGED_TARGETS.length)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("restores a displaced original V1 target without changing its backup", async () => {
  const target = await mkdtemp(join(tmpdir(), "opencode-setup-moved-"))
  try {
    await writeFile(join(target, "opencode.json"), "original")
    const installed = await install(target, { yes: true, backupRoot: backupRoot(target) })
    await restore(target, { backup: installed.backup, yes: true })
    assert.equal(await readFile(join(target, "opencode.json"), "utf8"), "original")
    assert.equal(await readFile(join(installed.backup, "opencode.json"), "utf8"), "original")
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("refuses restore over user-replaced files before changing any managed target", async () => {
  const target = await mkdtemp(join(tmpdir(), "opencode-setup-user-replaced-"))
  try {
    const source = resolve(import.meta.dirname, "../opencode/skills/context-mode-research")
    await mkdir(join(target, "skills"))
    await symlink(source, join(target, "skills/context-mode-research"))
    const installed = await install(target, { yes: true, backupRoot: backupRoot(target) })
    await rm(join(target, "plugins"))
    await writeFile(join(target, "plugins"), "user replacement")
    await assert.rejects(restore(target, { backup: installed.backup, yes: true }), /unmanaged target: plugins/)
    assert.equal(await readFile(join(target, "plugins"), "utf8"), "user replacement")
    assert(await pointsTo(join(target, "opencode.json"), resolve(import.meta.dirname, "../opencode/opencode.json")))
    await assert.rejects(lstat(join(target, "skills/context-mode-research")), { code: "ENOENT" })
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("recognizes only symlinks to the exact repository source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-setup-"))
  const source = join(directory, "source")
  const target = join(directory, "target")
  await mkdir(source)
  await writeFile(join(source, "file"), "source")
  await writeFile(target, "not a link")
  assert.equal(await pointsTo(target, join(source, "file")), false)
  await rm(target)
  await symlink(join(source, "file"), target)
  assert.equal(await pointsTo(target, join(source, "file")), true)
  assert.equal(await readlink(target), join(source, "file"))
  await rm(directory, { recursive: true, force: true })
})

test("allows a non-mutating install preview without confirmation", async () => {
  const target = await mkdtemp(join(tmpdir(), "opencode-setup-preview-"))
  const result = await install(target, { dryRun: true })
  assert.equal(result.action, "install")
  assert.equal(result.changes.length, MANAGED_TARGETS.length)
  await rm(target, { recursive: true, force: true })
})
