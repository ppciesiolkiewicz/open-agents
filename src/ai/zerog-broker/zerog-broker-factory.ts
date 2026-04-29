import { JsonRpcProvider, Wallet, type AbstractSigner } from 'ethers';
import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker';
import { ZEROG_NETWORKS, type ZeroGNetworkName } from '../../constants';

export interface BrokerEnv {
  WALLET_PRIVATE_KEY: string;
  ZEROG_NETWORK: ZeroGNetworkName;
}

// Resolves to the SDK's broker type. We intentionally `Awaited<ReturnType<...>>`
// rather than importing a named class — the SDK's exported types have churned
// across versions; this stays robust.
export type ZeroGBroker = Awaited<ReturnType<typeof createZGComputeNetworkBroker>>;

export async function buildZeroGBroker(env: BrokerEnv): Promise<{
  broker: ZeroGBroker;
  walletAddress: `0x${string}`;
}> {
  const network = ZEROG_NETWORKS[env.ZEROG_NETWORK];
  const provider = new JsonRpcProvider(network.rpcUrl);
  const wallet = new Wallet(env.WALLET_PRIVATE_KEY, provider);
  const broker = await createZGComputeNetworkBroker(wallet);
  return { broker, walletAddress: wallet.address as `0x${string}` };
}

export class ZeroGBrokerFactory {
  static async createBrokerFromSigner(
    signer: AbstractSigner,
    rpcUrl: string,
  ): Promise<ZeroGBroker> {
    return createZGComputeNetworkBroker(signer as any, rpcUrl);
  }
}
