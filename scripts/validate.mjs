import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const configPath = resolve(root, "opencode/opencode.json")
const config = JSON.parse(await readFile(configPath, "utf8"))

if (config.default_agent !== "plan") throw new Error("The default agent must remain plan.")
if (!config.agent?.plan || !config.agent?.compaction) throw new Error("Plan and compaction settings are required.")
if (config.plugin) throw new Error("V1 plugin configuration must not be active.")
const expectedPlugins = ["./plugins/compaction-reasoning.ts", "./plugins/rtk.ts"]
if (JSON.stringify(config.plugins) !== JSON.stringify(expectedPlugins)) {
  throw new Error("Both local V2 plugins must be explicitly registered relative to the global config.")
}
if (config.compaction?.buffer !== 32000 || config.compaction?.keep?.tokens !== 15000) throw new Error("V2 compaction budgets are required.")
if (config.compaction.reserved || config.compaction.preserve_recent_tokens) throw new Error("Legacy compaction keys must not be used.")
if (JSON.stringify(config).includes("/Users/")) throw new Error("Published config must not contain personal paths.")
if (config.model !== "openai/gpt-6-sol") throw new Error("The global model must remain GPT-6 Sol.")
for (const [name, expected] of Object.entries({
  explore: { model: "openai/gpt-6-luna", variant: "low" },
  general: { model: "openai/gpt-6-sol", variant: "medium" },
})) {
  if (config.agent[name]?.model !== expected.model || config.agent[name]?.variant !== expected.variant) {
    throw new Error(`Agent ${name} must use its configured GPT-6 route.`)
  }
}
for (const [name, expected] of Object.entries({
  build: { model: "openai/gpt-6-sol", reasoningEffort: "medium" },
  quick: { model: "openai/gpt-6-luna", reasoningEffort: "low" },
  deep: { model: "openai/gpt-6-astra", reasoningEffort: "xhigh" },
  visual: { model: "openai/gpt-6-luna", reasoningEffort: "medium" },
  "pr-reviewer": { model: "openai/gpt-6-sol", reasoningEffort: "high" },
})) {
  const source = await readFile(resolve(root, "opencode/agents", `${name}.md`), "utf8")
  if (!/^---\n[\s\S]*?^---\n/m.test(source)) throw new Error(`Agent ${name} has no frontmatter.`)
  for (const [key, value] of Object.entries(expected)) {
    if (!source.includes(`${key}: ${value}`)) throw new Error(`Agent ${name} must set ${key}: ${value}.`)
  }
}
const pluginFiles = await readdir(resolve(root, "opencode/plugins"))
if (pluginFiles.some((name) => name.startsWith("waiting-task"))) throw new Error("Waiting-task plugin must not autoload.")
for (const name of ["rtk.ts", "compaction-reasoning.ts"]) {
  if (!pluginFiles.includes(name)) throw new Error(`Retained V2 plugin missing: ${name}`)
  const source = await readFile(resolve(root, "opencode/plugins", name), "utf8")
  if (!source.includes("export default Plugin.define({")) throw new Error(`V2 plugin definition missing: ${name}`)
}
console.log("Configuration and managed agent sources are valid.")
