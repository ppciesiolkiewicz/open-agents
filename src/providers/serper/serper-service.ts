export interface SerperServiceOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface SerperOrganicResult {
  title: string;
  link: string;
  snippet?: string;
  position?: number;
}

export class SerperService {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: SerperServiceOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://google.serper.dev';
  }

  async searchWeb(query: string): Promise<SerperOrganicResult[]> {
    const res = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'X-API-KEY': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query }),
    });
    if (!res.ok) {
      throw new Error(`Serper request failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { organic?: SerperOrganicResult[] };
    return body.organic ?? [];
  }
}
