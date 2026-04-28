const SUPPRESSED_PATTERNS = [/\[Auto-funding\]/];

let installed = false;

export function silenceZeroGSdkNoise(): void {
  if (installed) return;
  installed = true;

  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]): void => {
    const first = args[0];
    if (typeof first === 'string' && SUPPRESSED_PATTERNS.some((p) => p.test(first))) {
      return;
    }
    originalWarn(...args);
  };
}
