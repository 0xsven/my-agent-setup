import { Plugin } from "@opencode/plugin"

// The dedicated compaction request hook only affects checkpoint summaries;
// provider scoping leaves other providers' options untouched.
export default Plugin.define({
  id: "local.compaction-reasoning",
  async setup(ctx) {
    await ctx.session.hook("compaction", (event) => {
      event.options.reasoningEffort = "medium"
    }, { providerID: "openai" })
  },
})
