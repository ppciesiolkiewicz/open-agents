import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/**
 * Asks a y/n question on stdin and returns true if the user types 'y' or 'yes'.
 * Test-only utility — used by *.interactive.test.ts to gate fund-spending
 * operations behind explicit operator confirmation.
 */
export async function confirmContinue(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const ans = (await rl.question(`\n${prompt} [y/N] `)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}
