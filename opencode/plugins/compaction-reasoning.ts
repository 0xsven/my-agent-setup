// V1 exposes request options through chat.params; V2 has a dedicated hook.
// Both paths affect only OpenAI checkpoint summaries.
export default {
  id: "local.compaction-reasoning",
  async server() {
    return {
      "chat.params": async (input, output) => {
        if (input.agent !== "compaction" || input.model.providerID !== "openai") return
        output.options.reasoningEffort = "medium"
      },
    }
  },
  async setup(ctx) {
    await ctx.session.hook("compaction", (event) => {
      event.options.reasoningEffort = "medium"
    }, { providerID: "openai" })
  },
}
