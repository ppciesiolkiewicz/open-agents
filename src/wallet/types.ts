import type { TransactionReceipt } from 'viem';

// Re-export viem's TransactionReceipt as our return type so real and dry-run
// wallets share the same shape. DryRunWallet synthesizes one with sentinel
// values; RealWallet returns it as-is from viem.
export type { TransactionReceipt };

export interface TxRequest {
  to: `0x${string}`;
  data?: `0x${string}`;
  value?: bigint;          // native value sent
  gas?: bigint;            // optional override; DryRunWallet copies into receipt.gasUsed
  gasPriceWei?: bigint;    // optional; DryRunWallet copies into receipt.effectiveGasPrice
}
