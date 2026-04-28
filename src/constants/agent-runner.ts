export const AGENT_RUNNER = {
  // Hard cap on LLM↔tool round-trips inside a single agent tick.
  // Each round = one LLM call, possibly with tool dispatches before the next.
  // Cap exists so a confused LLM cannot loop forever; if hit we log an error
  // entry and end the tick.
  maxToolRoundsPerTick: 10,
  // Bounds prompt-token cost on 0G by capping activity-log entries fed into
  // the chat history; a sliding-window compaction strategy is a planned follow-up.
  chatHistoryLimit: 200,
} as const;
