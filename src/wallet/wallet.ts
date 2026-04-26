import type { TransactionReceipt, TxRequest } from './types';

export interface Wallet {
  getAddress(): `0x${string}`;
  getNativeBalance(): Promise<bigint>;
  getTokenBalance(tokenAddress: `0x${string}`): Promise<bigint>;
  signAndSendTransaction(req: TxRequest): Promise<TransactionReceipt>;
}
