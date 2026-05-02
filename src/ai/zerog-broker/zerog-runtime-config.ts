import type { Env } from '../../config/env';
import type { ZeroGRuntimeConfig } from './types';

export class ZeroGRuntimeConfigLoader {
  static fromEnv(env: Env): ZeroGRuntimeConfig | null {
    const { ZEROG_PROVIDER_ADDRESS, ZEROG_SERVICE_URL, ZEROG_MODEL, ZEROG_NETWORK } = env;
    const anySet = ZEROG_PROVIDER_ADDRESS || ZEROG_SERVICE_URL || ZEROG_MODEL;
    const allSet = ZEROG_PROVIDER_ADDRESS && ZEROG_SERVICE_URL && ZEROG_MODEL;
    if (!anySet) return null;
    if (!allSet) {
      throw new Error(
        '0G env partially set: ZEROG_PROVIDER_ADDRESS, ZEROG_SERVICE_URL, and ZEROG_MODEL must all be set together (or all unset to fall back to StubLLMClient). Run `npm run zerog-bootstrap` to discover values.',
      );
    }
    return {
      network: ZEROG_NETWORK,
      providerAddress: ZEROG_PROVIDER_ADDRESS as `0x${string}`,
      serviceUrl: ZEROG_SERVICE_URL,
      model: ZEROG_MODEL,
    };
  }
}
