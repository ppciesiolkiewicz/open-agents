import { ethers } from 'ethers';
import type { PrivyClient } from '@privy-io/server-auth';

export class PrivyZeroGSigner extends ethers.AbstractSigner {
  constructor(
    private readonly privy: PrivyClient,
    private readonly walletId: string,
    private readonly walletAddress: string,
    private readonly chainId: number,
    provider: ethers.Provider,
  ) {
    super(provider);
  }

  async getAddress(): Promise<string> {
    return this.walletAddress;
  }

  async signTransaction(_tx: ethers.TransactionRequest): Promise<string> {
    throw new Error('PrivyZeroGSigner: use sendTransaction instead of signTransaction');
  }

  async signMessage(_message: string | Uint8Array): Promise<string> {
    throw new Error('PrivyZeroGSigner: signMessage not supported');
  }

  async signTypedData(
    _domain: ethers.TypedDataDomain,
    _types: Record<string, ethers.TypedDataField[]>,
    _value: Record<string, unknown>,
  ): Promise<string> {
    throw new Error('PrivyZeroGSigner: signTypedData not supported');
  }

  override async sendTransaction(tx: ethers.TransactionRequest): Promise<ethers.TransactionResponse> {
    const caip2 = `eip155:${this.chainId}`;
    const { hash } = await (this.privy.walletApi as any).ethereum.sendTransaction({
      walletId: this.walletId,
      caip2,
      transaction: {
        to: tx.to as string,
        data: tx.data ? ethers.hexlify(tx.data as ethers.BytesLike) : undefined,
        value: tx.value ? ethers.toBeHex(tx.value) : undefined,
        chainId: this.chainId,
      },
    });
    const response = await this.provider!.getTransaction(hash);
    if (!response) throw new Error(`PrivyZeroGSigner: tx ${hash} not found after send`);
    return response;
  }

  connect(provider: ethers.Provider): PrivyZeroGSigner {
    return new PrivyZeroGSigner(this.privy, this.walletId, this.walletAddress, this.chainId, provider);
  }
}
