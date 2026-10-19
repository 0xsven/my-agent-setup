// The dedicated compaction request hook only affects checkpoint summaries;
// provider scoping leaves other providers' options untouched.
export default {
  id: "local.compaction-reasoning",
  async setup(ctx) {
    await ctx.session.hook("compaction", (event) => {
      event.options.reasoningEffort = "medium"
    }, { providerID: "openai" })
  },
}
