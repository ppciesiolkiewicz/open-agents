import { JsonRpcProvider, Wallet, type AbstractSigner, type Signer } from 'ethers';
import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker';
import { ZEROG_NETWORKS, type ZeroGNetworkName } from '../../constants';

export interface BrokerInputs {
  signer: Signer;
  ZEROG_NETWORK: ZeroGNetworkName;
}

export type ZeroGBroker = Awaited<ReturnType<typeof createZGComputeNetworkBroker>>;

export async function buildZeroGBroker(inputs: BrokerInputs): Promise<{
  broker: ZeroGBroker;
  walletAddress: `0x${string}`;
}> {
  const broker = await createZGComputeNetworkBroker(inputs.signer as any);
  const walletAddress = (await inputs.signer.getAddress()) as `0x${string}`;
  return { broker, walletAddress };
}

export function buildZeroGProvider(network: ZeroGNetworkName): JsonRpcProvider {
  return new JsonRpcProvider(ZEROG_NETWORKS[network].rpcUrl);
}

export function buildEnvPkZeroGSigner(privateKey: string, network: ZeroGNetworkName): Wallet {
  return new Wallet(privateKey, buildZeroGProvider(network));
}

export class ZeroGBrokerFactory {
  static async createBrokerFromSigner(signer: AbstractSigner): Promise<ZeroGBroker> {
    return createZGComputeNetworkBroker(signer as any);
  }
}
