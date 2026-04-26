export const DRY_RUN_HASH_REGEX = /^0x0{60}[0-9a-f]{4}$/;

let counter = 0;

export function generateDryRunHash(): string {
  counter = (counter + 1) & 0xffff;       // wrap at 65535, fits in 4 hex
  const suffix = counter.toString(16).padStart(4, '0');
  return `0x${'0'.repeat(60)}${suffix}`;
}
