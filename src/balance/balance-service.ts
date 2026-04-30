import { createPublicClient, http, erc20Abi, defineChain } from 'viem';
import { unichain } from 'viem/chains';
import type { CoingeckoService } from '../providers/coingecko/coingecko-service';
import { USDC_ON_UNICHAIN, ZEROG_NETWORKS, ZEROG_NATIVE_TOKEN, resolveUnichainRpcUrl } from '../constants';

export interface WalletBalanceItem {
  raw: string;
  formatted: string;
}

export interface OgBalance extends WalletBalanceItem {
  priceUsd: number;
  valueUsd: number;
}

export interface WalletBalances {
  usdcOnUnichain: WalletBalanceItem;
  ogOnZerog: OgBalance;
}

export interface TokenForBalance {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  chainId: number;
}

export interface TokenBalanceItem {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
  raw: string;
  formatted: string;
}

export interface BalanceServiceEnv {
  ALCHEMY_API_KEY: string;
  UNICHAIN_RPC_URL?: string;
  ZEROG_NETWORK: 'mainnet' | 'testnet';
}

export class BalanceService {
  private readonly unichainClient;
  private readonly zerogClient;
  private readonly coingecko: CoingeckoService;

  constructor(env: BalanceServiceEnv, coingecko: CoingeckoService) {
    this.coingecko = coingecko;

    const unichainRpc = resolveUnichainRpcUrl(env);
    this.unichainClient = createPublicClient({ chain: unichain, transport: http(unichainRpc) });

    const zerogNet = ZEROG_NETWORKS[env.ZEROG_NETWORK];
    const zerogChain = defineChain({
      id: zerogNet.chainId,
      name: `0G ${env.ZEROG_NETWORK}`,
      nativeCurrency: { name: '0G', symbol: ZEROG_NATIVE_TOKEN.symbol, decimals: ZEROG_NATIVE_TOKEN.decimals },
      rpcUrls: { default: { http: [zerogNet.rpcUrl] } },
    });
    this.zerogClient = createPublicClient({ chain: zerogChain, transport: http(zerogNet.rpcUrl) });
  }

  async fetchWalletBalances(address: `0x${string}`): Promise<WalletBalances> {
    const [usdcRaw, ogRaw, ogPrice] = await Promise.all([
      this.unichainClient.readContract({
        address: USDC_ON_UNICHAIN.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      }) as Promise<bigint>,
      this.zerogClient.getBalance({ address }),
      this.coingecko.fetchTokenPriceUSD(ZEROG_NATIVE_TOKEN.coingeckoId),
    ]);

    const usdcFormatted = formatTokenAmount(usdcRaw, USDC_ON_UNICHAIN.decimals);
    const ogFormatted = formatTokenAmount(ogRaw, ZEROG_NATIVE_TOKEN.decimals);
    const ogValue = parseFloat(ogFormatted) * ogPrice;

    return {
      usdcOnUnichain: {
        raw: usdcRaw.toString(),
        formatted: usdcFormatted,
      },
      ogOnZerog: {
        raw: ogRaw.toString(),
        formatted: ogFormatted,
        priceUsd: ogPrice,
        valueUsd: Math.round(ogValue * 1e6) / 1e6,
      },
    };
  }

  async fetchTokenBalancesOnUnichain(
    wallet: `0x${string}`,
    tokens: TokenForBalance[],
  ): Promise<TokenBalanceItem[]> {
    if (tokens.length === 0) return [];
    const results = await this.unichainClient.multicall({
      contracts: tokens.map((t) => ({
        address: t.address,
        abi: erc20Abi,
        functionName: 'balanceOf' as const,
        args: [wallet] as const,
      })),
      allowFailure: true,
    });
    return tokens.map((t, i) => {
      const r = results[i];
      const raw = r && r.status === 'success' ? (r.result as bigint) : 0n;
      return {
        chainId: t.chainId,
        address: t.address,
        symbol: t.symbol,
        decimals: t.decimals,
        raw: raw.toString(),
        formatted: formatTokenAmount(raw, t.decimals),
      };
    });
  }
}

function formatTokenAmount(raw: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;
  const fracStr = remainder.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}
