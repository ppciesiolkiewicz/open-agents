import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { FirecrawlService } from '../../providers/firecrawl/firecrawl-service';

const MAX_CHARS = 4_000;

const inputSchema = z.object({
  url: z.string().describe('Absolute URL to scrape'),
});

export function buildFirecrawlScrapeTool(svc: FirecrawlService): AgentTool<typeof inputSchema> {
  return {
    name: 'scrapeUrlMarkdown',
    description:
      'Scrape a URL and return its content as markdown (truncated to 4000 chars).',
    inputSchema,
    async invoke({ url }) {
      const md = await svc.scrapeUrlMarkdown(url);
      return md.length > MAX_CHARS ? md.slice(0, MAX_CHARS) + '\n...[truncated]' : md;
    },
  };
}
