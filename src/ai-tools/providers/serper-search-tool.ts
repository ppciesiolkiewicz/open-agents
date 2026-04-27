import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { SerperService } from '../../providers/serper/serper-service';

const MAX_RESULTS = 5;

const inputSchema = z.object({
  query: z.string().describe('Search query'),
});

export function buildSerperSearchTool(svc: SerperService): AgentTool<typeof inputSchema> {
  return {
    name: 'searchWeb',
    description:
      'Search Google via Serper and return the top 5 organic results as an array of {title, link, snippet}.',
    inputSchema,
    async invoke({ query }) {
      const results = await svc.searchWeb(query);
      return results.slice(0, MAX_RESULTS).map((r) => ({
        title: r.title,
        link: r.link,
        snippet: r.snippet,
      }));
    },
  };
}
