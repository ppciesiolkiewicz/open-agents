import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileActivityLogStore } from './file-activity-log-store';
import type { AgentActivityLogEntry } from './types';

function makeEntry(agentId: string, tickId: string, type: AgentActivityLogEntry['type']): AgentActivityLogEntry {
  return {
    agentId,
    tickId,
    timestamp: Date.now(),
    type,
    payload: { note: `${type} for ${tickId}` },
  };
}

describe('FileActivityLogStore (live, real filesystem)', () => {
  let dbDir: string;
  let store: FileActivityLogStore;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'agent-loop-log-'));
    store = new FileActivityLogStore(dbDir);
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it('appends entries and reads them back in order', async () => {
    await store.append(makeEntry('a1', 't1', 'tick_start'));
    await store.append(makeEntry('a1', 't1', 'tool_call'));
    await store.append(makeEntry('a1', 't1', 'tick_end'));

    const entries = await store.listByAgent('a1');
    console.log('[activity-log] entries for a1:', entries.map((e) => e.type));
    expect(entries.map((e) => e.type)).toEqual(['tick_start', 'tool_call', 'tick_end']);
  });

  it('isolates entries per agent', async () => {
    await store.append(makeEntry('a1', 't1', 'tick_start'));
    await store.append(makeEntry('a2', 't9', 'tick_start'));

    const a1 = await store.listByAgent('a1');
    const a2 = await store.listByAgent('a2');
    expect(a1).toHaveLength(1);
    expect(a2).toHaveLength(1);
    expect(a1[0]!.agentId).toBe('a1');
    expect(a2[0]!.agentId).toBe('a2');
  });

  it('returns empty array when agent has no log file', async () => {
    expect(await store.listByAgent('nobody')).toEqual([]);
  });

  it('limit returns the most recent N entries', async () => {
    for (let i = 0; i < 5; i++) await store.append(makeEntry('a1', `t${i}`, 'tick_start'));
    const last2 = await store.listByAgent('a1', { limit: 2 });
    expect(last2.map((e) => e.tickId)).toEqual(['t3', 't4']);
  });

  it('sinceTickId returns entries after the matching tickId', async () => {
    await store.append(makeEntry('a1', 't1', 'tick_start'));
    await store.append(makeEntry('a1', 't2', 'tick_start'));
    await store.append(makeEntry('a1', 't3', 'tick_start'));

    const after1 = await store.listByAgent('a1', { sinceTickId: 't1' });
    expect(after1.map((e) => e.tickId)).toEqual(['t2', 't3']);
  });

  it('writes NDJSON (one JSON object per line) to db/activity-log/<agentId>.json', async () => {
    await store.append(makeEntry('a1', 't1', 'tick_start'));
    await store.append(makeEntry('a1', 't1', 'tick_end'));

    const raw = await readFile(join(dbDir, 'activity-log', 'a1.json'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).type).toBe('tick_start');
    expect(JSON.parse(lines[1]!).type).toBe('tick_end');
  });
});
