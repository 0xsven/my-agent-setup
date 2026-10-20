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

test("auto-discovered global plugins resolve through installed symlinks", async () => {
  const target = await mkdtemp(join(tmpdir(), "opencode-setup-plugin-paths-"))
  try {
    await install(target, { yes: true, backupRoot: backupRoot(target) })
    for (const name of ["compaction-reasoning.ts", "rtk.ts"]) {
      const actual = await realpath(join(target, "plugins", name))
      const expected = await realpath(resolve(import.meta.dirname, "../opencode/plugins", name))
      assert.equal(actual, expected)
    }
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("reinstall creates no backup and rejects legacy manifests without removing installed links", async () => {
  const target = await mkdtemp(join(tmpdir(), "opencode-setup-reinstall-"))
  try {
    const first = await install(target, { yes: true, backupRoot: backupRoot(target) })
    const next = await install(target, { yes: true, backupRoot: backupRoot(target), now: new Date("2030-01-01") })
    assert.equal(next.backup, undefined)
    assert.deepEqual(next.changes, [])
    const legacy = join(target, "legacy-backup")
    await mkdir(legacy)
    await writeFile(join(legacy, "manifest.json"), JSON.stringify({ target, moved: [], managed: MANAGED_TARGETS }))
    await assert.rejects(restore(target, { backup: legacy, yes: true }), /Unsupported or malformed/)
    for (const entry of planTargets(target)) assert(await pointsTo(entry.destination, entry.source))
    await restore(target, { backup: first.backup, yes: true })
    for (const entry of planTargets(target)) await assert.rejects(lstat(entry.destination), { code: "ENOENT" })
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("rejects retired-target manifests without changing managed links", async () => {
  const target = await mkdtemp(join(tmpdir(), "opencode-setup-legacy-retired-"))
  try {
    const installed = await install(target, { yes: true, backupRoot: backupRoot(target) })
    const oldManifest = join(target, "old-manifest")
    await mkdir(oldManifest)
    await writeFile(join(oldManifest, "manifest.json"), JSON.stringify({
      target,
      moved: [],
      created: ["opencode.json"],
      managed: MANAGED_TARGETS,
      retired: [{ entry: "skills/context-mode-research", source: "/legacy/context-mode-research" }],
    }))
    await assert.rejects(restore(target, { backup: oldManifest, yes: true }), /Unsupported or malformed/)
    for (const entry of planTargets(target)) assert(await pointsTo(entry.destination, entry.source))
    const manifest = JSON.parse(await readFile(join(installed.backup, "manifest.json"), "utf8"))
    assert.equal(manifest.created.length, MANAGED_TARGETS.length)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("restores a displaced original target without changing its backup", async () => {
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
    const installed = await install(target, { yes: true, backupRoot: backupRoot(target) })
    await rm(join(target, "plugins"))
    await writeFile(join(target, "plugins"), "user replacement")
    await assert.rejects(restore(target, { backup: installed.backup, yes: true }), /unmanaged target: plugins/)
    assert.equal(await readFile(join(target, "plugins"), "utf8"), "user replacement")
    assert(await pointsTo(join(target, "opencode.json"), resolve(import.meta.dirname, "../opencode/opencode.json")))
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
