export interface CoinMarketCapServiceOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface CmcTokenInfo {
  id: number;
  name: string;
  symbol: string;
  slug: string;
  category?: string;
  description?: string;
}

export class CoinMarketCapService {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: CoinMarketCapServiceOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://pro-api.coinmarketcap.com';
  }

  async fetchTokenInfoBySymbol(symbol: string): Promise<CmcTokenInfo> {
    const url = `${this.baseUrl}/v2/cryptocurrency/info?symbol=${encodeURIComponent(symbol)}`;
    const res = await fetch(url, {
      headers: {
        'X-CMC_PRO_API_KEY': this.apiKey,
        accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`CoinMarketCap request failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { data?: Record<string, CmcTokenInfo[]> };
    const entry = body.data?.[symbol]?.[0];
    if (!entry) {
      throw new Error(`CoinMarketCap response missing entry for ${symbol}`);
    }
    return entry;
  }
}
