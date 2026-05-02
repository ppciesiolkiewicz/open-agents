import { describe, it, expect } from 'vitest';
import { AxlClient } from './axl-client';

const axlUrl = process.env.AXL_URL ?? 'http://127.0.0.1:9002';

async function isAxlReachable(url: string): Promise<boolean> {
  try {
    await new AxlClient(url).getTopology();
    return true;
  } catch {
    return false;
  }
}

describe('AxlClient (live, requires running AXL node)', () => {
  it('getTopology returns a non-empty peer ID', async () => {
    if (!await isAxlReachable(axlUrl)) {
      console.warn(`[axl-client.live] AXL node not reachable at ${axlUrl} — skipping`);
      return;
    }
    const client = new AxlClient(axlUrl);
    const topology = await client.getTopology();
    console.log('[axl-client.live] topology:', topology);
    expect(topology.ourPeerId).toBeTruthy();
    expect(topology.ourPeerId.length).toBeGreaterThan(0);
  });

  it('recv returns null when queue is empty', async () => {
    if (!await isAxlReachable(axlUrl)) {
      console.warn(`[axl-client.live] AXL node not reachable at ${axlUrl} — skipping`);
      return;
    }
    const client = new AxlClient(axlUrl);
    const msg = await client.recv();
    console.log('[axl-client.live] recv result:', msg);
    expect(msg).toBeNull();
  });
});
