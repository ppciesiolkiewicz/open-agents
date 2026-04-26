import { describe, it, expect } from 'vitest';
import { generateDryRunHash, DRY_RUN_HASH_REGEX } from './dry-run-hash';

describe('generateDryRunHash', () => {
  it('produces a 0x-prefixed 32-byte hex string', () => {
    const h = generateDryRunHash();
    console.log('[dry-run-hash] sample:', h);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.length).toBe(66);
  });

  it('matches the documented sentinel pattern (60 leading zeros + 4 hex)', () => {
    const h = generateDryRunHash();
    expect(h).toMatch(DRY_RUN_HASH_REGEX);
    expect(DRY_RUN_HASH_REGEX.source).toBe('^0x0{60}[0-9a-f]{4}$');
  });

  it('produces unique hashes across rapid calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateDryRunHash());
    expect(seen.size).toBe(1000);
  });
});
