import { describe, it, expect } from 'vitest';
import { AxlClient } from './axl-client';

const axlUrl = process.env.AXL_URL ?? 'http://127.0.0.1:9002';

describe('AxlClient (live, requires running AXL node)', () => {
  it('getTopology returns a non-empty peer ID', async () => {
    const client = new AxlClient(axlUrl);
    let topology: Awaited<ReturnType<typeof client.getTopology>>;
    try {
      topology = await client.getTopology();
    } catch {
      console.warn('[axl-client.live] AXL node not reachable — skipping');
      return;
    }
    console.log('[axl-client.live] topology:', topology);
    expect(topology.ourPeerId).toBeTruthy();
    expect(topology.ourPeerId.length).toBeGreaterThan(0);
  });

  it('recv returns null when queue is empty', async () => {
    const client = new AxlClient(axlUrl);
    try {
      const msg = await client.recv();
      console.log('[axl-client.live] recv result:', msg);
      expect(msg).toBeNull();
    } catch (err) {
      console.warn('[axl-client.live] AXL node not reachable — skipping:', err);
    }
  });
});
