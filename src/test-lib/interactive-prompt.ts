import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const SEPARATOR = '─'.repeat(60);

/**
 * Asks a y/n question on stdin and returns true if the user types 'y' or 'yes'.
 * Test-only utility — used by *.interactive.test.ts to gate fund-spending
 * operations behind explicit operator confirmation.
 *
 * The prompt is wrapped in a separator banner because vitest captures stdout
 * by default and the prompt can otherwise be hidden in the test reporter
 * output. The interactive vitest config disables this interception, but the
 * banner makes the prompt unmissable in any reporter mode.
 */
export async function confirmContinue(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`\n${SEPARATOR}\n`);
    stdout.write(`INTERACTIVE TEST CONFIRMATION REQUIRED\n`);
    stdout.write(`${SEPARATOR}\n`);
    const ans = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
    stdout.write(`${SEPARATOR}\n`);
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}
