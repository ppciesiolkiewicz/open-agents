import { describe, it, expect } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { buildToolsRouter } from './tools';
import { TOOL_CATALOG } from '../../ai-tools/tool-catalog';

const app = express();
app.use('/tools', buildToolsRouter());

describe('GET /tools (live)', () => {
  it('returns the configured tool catalog', async () => {
    const r = await supertest(app).get('/tools');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ tools: TOOL_CATALOG });
    expect(Array.isArray(r.body.tools)).toBe(true);
    expect(r.body.tools.length).toBeGreaterThan(0);
    console.log('GET /tools sample:', r.body.tools[0]);
  });
});
