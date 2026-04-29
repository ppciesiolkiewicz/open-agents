import { z } from 'zod';

const envSchema = z.object({
  WALLET_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'must be 0x-prefixed 32-byte hex'),

  ALCHEMY_API_KEY: z.string().min(1),
  UNICHAIN_RPC_URL: z.string().url().optional(),

  ZEROG_NETWORK: z.enum(['mainnet', 'testnet']),
  ZEROG_PROVIDER_ADDRESS: z.string().min(1).optional(),

  COINGECKO_API_KEY: z.string().min(1),
  COINMARKETCAP_API_KEY: z.string().min(1),
  SERPER_API_KEY: z.string().min(1),
  FIRECRAWL_API_KEY: z.string().min(1),

  DB_DIR: z.string().default('./db'),
  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url().optional(),

  PRIVY_APP_ID: z.string().min(1).optional(),
  PRIVY_APP_SECRET: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  API_CORS_ORIGINS: z.string().optional(),
  MODE: z.enum(['looper', 'server', 'both']).default('both'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(raw: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid env: ${issues}`);
  }
  return parsed.data;
}
