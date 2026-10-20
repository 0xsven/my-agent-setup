import { execFile } from "node:child_process"
import { promisify } from "node:util"

// RTK OpenCode plugin — rewrites commands to use rtk for token savings.
// Requires: rtk >= 0.23.0 in PATH.
//
// This is a thin delegating plugin: all rewrite logic lives in `rtk rewrite`,
// which is the single source of truth (src/discover/registry.rs).
// To add or change rewrite rules, edit the Rust registry — not this file.

const run = promisify(execFile)

async function available() {
  try {
    await run("rtk", ["--version"])
    return true
  } catch {
    console.warn("[rtk] rtk binary not found in PATH — plugin disabled")
    return false
  }
}

export async function rewriteInput(input: { command?: unknown }, execute = run) {
  const command = input?.command
  if (typeof command !== "string" || !command) return
  try {
    const { stdout } = await execute("rtk", ["rewrite", command])
    const rewritten = stdout.trim()
    if (rewritten && rewritten !== command) input.command = rewritten
  } catch {
    // rtk rewrite failed — pass through unchanged
  }
}

export default {
  id: "local.rtk",
  async server() {
    if (!await available()) return {}
    return {
      "tool.execute.before": async (input, output) => {
        if (input.tool !== "bash" && input.tool !== "shell") return
        await rewriteInput(output.args)
      },
    }
  },
  async setup(ctx) {
    if (!await available()) return

    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "bash" && event.tool !== "shell") return
      await rewriteInput(event.input as { command?: unknown })
    })
  },
}
