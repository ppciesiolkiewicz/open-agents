export const FEE_TIERS = {
  LOW: 500,
  MEDIUM: 3_000,
  HIGH: 10_000,
} as const;

export type FeeTier = (typeof FEE_TIERS)[keyof typeof FEE_TIERS];
