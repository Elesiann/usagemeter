// Type-only stand-ins for the parts of T3 Code's `@t3tools/contracts` package
// that the vendored usage modules import. Upstream defines them as Effect
// schemas in packages/contracts/src/usage.ts and settings.ts; only the
// TypeScript shapes are needed here.

export type UsageProviderKind = "claude" | "codex" | "grok" | "cursor" | "opencode" | "antigravity";

export type UsageDay = string;

export type UsageResolution = "day" | "hour";

export type UsageCostSource = "providerReported" | "modelPriced" | "unpriced";

export interface UsageTokenTotals {
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export interface UsageCategoryCost {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

export interface UsageModelPriceOverride {
  readonly inputCostPerMillionTokens: number;
  readonly outputCostPerMillionTokens: number;
  readonly cacheReadCostPerMillionTokens?: number;
  readonly cacheWriteCostPerMillionTokens?: number;
}

export interface UsageBucket {
  readonly day: UsageDay;
  readonly hourStart?: string;
  readonly provider: UsageProviderKind;
  readonly model: string;
  readonly sourcePath?: string;
  readonly totals: UsageTokenTotals;
  readonly costUsd: number;
  readonly cacheSavingsUsd: number;
  readonly categoryCostUsd?: UsageCategoryCost;
  readonly fastCostUsd?: number;
  readonly ultrafastCostUsd?: number;
  readonly speedPremiumUsd?: number;
  readonly costSource: UsageCostSource;
  readonly records: number;
  readonly unpricedRecords: number;
  readonly sessions: number;
}
