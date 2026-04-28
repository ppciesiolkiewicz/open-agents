const SUPPRESSED_WARN_PATTERNS = [/\[Auto-funding\]/];

const SDK_MODULE_HINTS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /0g-serving-broker[/\\][^"\n]*ledger[/\\]/i, label: 'ledger' },
  { pattern: /0g-serving-broker[/\\][^"\n]*inference[/\\]/i, label: 'inference' },
  { pattern: /0g-serving-broker[/\\][^"\n]*fine-tuning[/\\]/i, label: 'fine-tuning' },
];

function classifyZeroGCaller(): string {
  const stack = new Error().stack ?? '';
  for (const { pattern, label } of SDK_MODULE_HINTS) {
    if (pattern.test(stack)) return label;
  }
  return 'unknown';
}

let installed = false;

export function silenceZeroGSdkNoise(): void {
  if (installed) return;
  installed = true;

  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]): void => {
    const first = args[0];
    if (typeof first === 'string' && SUPPRESSED_WARN_PATTERNS.some((p) => p.test(first))) {
      return;
    }
    originalWarn(...args);
  };

  const originalLog = console.log.bind(console);
  console.log = (...args: unknown[]): void => {
    const first = args[0];
    if (typeof first === 'string' && first.startsWith('sending tx with gas price')) {
      const module = classifyZeroGCaller();
      originalLog(`[zerog-sdk:${module}] ${first}`, ...args.slice(1));
      return;
    }
    originalLog(...args);
  };
}
