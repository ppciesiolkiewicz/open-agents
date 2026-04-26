export interface CoingeckoServiceOptions {
  apiKey: string;
  baseUrl?: string;
}

export class CoingeckoService {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: CoingeckoServiceOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.coingecko.com/api/v3';
  }

  async fetchTokenPriceUSD(coingeckoId: string): Promise<number> {
    const url = `${this.baseUrl}/simple/price?ids=${encodeURIComponent(coingeckoId)}&vs_currencies=usd`;
    const res = await fetch(url, {
      headers: { 'x-cg-demo-api-key': this.apiKey, accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Coingecko request failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as Record<string, { usd?: number }>;
    const price = body[coingeckoId]?.usd;
    if (typeof price !== 'number') {
      throw new Error(`Coingecko response missing usd price for ${coingeckoId}`);
    }
    return price;
  }
}
