export interface FirecrawlServiceOptions {
  apiKey: string;
  baseUrl?: string;
}

export class FirecrawlService {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: FirecrawlServiceOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.firecrawl.dev';
  }

  async scrapeUrlMarkdown(url: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/scrape`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url, formats: ['markdown'] }),
    });
    if (!res.ok) {
      throw new Error(`Firecrawl request failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as {
      success: boolean;
      data?: { markdown?: string };
      error?: string;
    };
    if (!body.success) {
      throw new Error(`Firecrawl returned error: ${body.error ?? 'unknown'}`);
    }
    const markdown = body.data?.markdown;
    if (typeof markdown !== 'string') {
      throw new Error('Firecrawl response missing markdown body');
    }
    return markdown;
  }
}
