export const AGENT_RUNNER = {
  // Hard cap on LLM↔tool round-trips inside a single agent tick.
  // Each round = one LLM call, possibly with tool dispatches before the next.
  // Cap exists so a confused LLM cannot loop forever; if hit we log an error
  // entry and end the tick.
  maxToolRoundsPerTick: 10,
} as const;
