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
      // demo-tier header; switch to 'x-cg-pro-api-key' if upgrading to a pro plan
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

  async fetchTokenPricesByContract(
    platform: string,
    addresses: string[],
  ): Promise<Record<string, number>> {
    if (addresses.length === 0) return {};
    const lower = addresses.map((a) => a.toLowerCase());
    const url =
      `${this.baseUrl}/simple/token_price/${encodeURIComponent(platform)}` +
      `?contract_addresses=${lower.join(',')}&vs_currencies=usd`;
    const res = await fetch(url, {
      headers: { 'x-cg-demo-api-key': this.apiKey, accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Coingecko request failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as Record<string, { usd?: number }>;
    const out: Record<string, number> = {};
    for (const addr of lower) {
      const price = body[addr]?.usd;
      if (typeof price === 'number') out[addr] = price;
    }
    return out;
  }
}
