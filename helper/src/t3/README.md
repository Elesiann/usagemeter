# Vendored from T3 Code

These files come from [T3 Code](https://github.com/pingdotgg/t3code) at commit
`f32c23cf`, under the MIT license in `LICENSE` here.

| File | Upstream path |
| --- | --- |
| `usage/usageTranscripts.ts`, `usageTranscriptReader.ts`, `usagePricing.ts`, `usageAggregation.ts`, `usageScanCache.ts`, `opencodeUsageReader.ts`, `antigravityUsageReader.ts` | `apps/server/src/usage/` |
| `project/AgentSessionJson.ts` | `apps/server/src/project/` |
| `contracts.ts` | Not vendored: type-only stand-ins for `packages/contracts/src/usage.ts` and `settings.ts` |

The only change to the vendored files is the `@t3tools/contracts` import, which
points at `contracts.ts`. To update, copy the files again from a newer commit,
reapply that import change, run the tests and rebuild the bundle.
