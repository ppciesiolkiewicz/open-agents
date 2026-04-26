import type { ZeroGNetworkName } from '../../constants';

// Persisted runtime state — written by the bootstrap CLI, read by `npm start`.
// Contains no secrets (0G auth is per-call via broker.inference.getRequestHeaders).
export interface ZeroGBootstrapState {
  network: ZeroGNetworkName;
  providerAddress: `0x${string}`;
  serviceUrl: string;        // OpenAI-compatible base URL for the chat completions endpoint
  model: string;             // e.g. "llama-3.3-70b-instruct"
  acknowledgedAt: number;    // epoch ms — when broker.inference.acknowledgeProviderSigner ran
  fundedAt: number;          // epoch ms — when transferFund last completed
  fundAmountOG: number;      // OG value transferred to provider sub-account on the most recent fund
}

// Returned by ZeroGBrokerService.listProviders for CLI display.
export interface ProviderListing {
  providerAddress: `0x${string}`;
  serviceUrl: string;
  model: string;
  inputPricePerToken?: bigint;  // wei per token
  outputPricePerToken?: bigint; // wei per token
  subAccountBalanceWei?: bigint; // best-effort; undefined if the SDK does not expose it
}
