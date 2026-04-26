import { describe, it, expect } from 'vitest';
import { FirecrawlService } from './firecrawl-service';

const apiKey = process.env.FIRECRAWL_API_KEY;

describe.skipIf(!apiKey)('FirecrawlService (live)', () => {
  const svc = new FirecrawlService({ apiKey: apiKey! });

  it('scrapes uniswap.org and returns markdown', async () => {
    const md = await svc.scrapeUrlMarkdown('https://uniswap.org');
    console.log('[firecrawl] uniswap.org markdown length:', md.length);
    console.log('[firecrawl] first 300 chars:\n', md.slice(0, 300));
    expect(md.length).toBeGreaterThan(100);
    expect(md.toLowerCase()).toContain('uniswap');
  }, 30_000);
});
