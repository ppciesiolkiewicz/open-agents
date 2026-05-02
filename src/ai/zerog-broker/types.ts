import type { ZeroGNetworkName } from '../../constants';

// Runtime 0G inference target — derived from env vars (ZEROG_NETWORK,
// ZEROG_PROVIDER_ADDRESS, ZEROG_SERVICE_URL, ZEROG_MODEL). Contains no secrets
// (0G auth is per-call via broker.inference.getRequestHeaders).
export interface ZeroGRuntimeConfig {
  network: ZeroGNetworkName;
  providerAddress: `0x${string}`;
  serviceUrl: string;        // OpenAI-compatible base URL for the chat completions endpoint
  model: string;             // e.g. "qwen/qwen3-vl-30b-a3b-instruct"
}

// Returned by ZeroGBrokerService.listProviders for CLI display.
export interface ProviderListing {
  providerAddress: `0x${string}`;
  serviceUrl: string;
  model: string;
  serviceType: string;
  inputPricePerToken?: bigint;  // wei per token
  outputPricePerToken?: bigint; // wei per token
  subAccountBalanceWei?: bigint; // best-effort; undefined if the SDK does not expose it
}
