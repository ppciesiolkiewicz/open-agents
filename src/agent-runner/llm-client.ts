import type { ZodTypeAny } from 'zod';

export interface LLMResponse {
  content: string;
  tokenCount?: number;
}

// Tool descriptor as the LLM sees it. The actual function body lives in AgentTool;
// LLMClient only needs the schema for the chat completion call.
export interface ToolDefinition {
  name: string;
  description: string;
  parametersSchema: ZodTypeAny;
}

// One call from the model asking us to run a tool.
export interface ToolCall {
  id: string;             // OpenAI tool_call id; must round-trip in the tool reply message
  name: string;
  argumentsJson: string;  // raw JSON; AgentRunner parses + zod-validates against the matching ToolDefinition
}

// One reply the runner sends back to the model after running a tool.
export interface ToolReply {
  toolCallId: string;     // matches ToolCall.id
  content: string;        // tool output OR error message ('error: <message>')
}

// Conversation transcript shape the runner accumulates between rounds.
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LLMTurnResult {
  // Either content (model is done) or toolCalls (model wants more work) or both.
  content?: string;
  toolCalls?: ToolCall[];
  tokenCount?: number;
  // Pass-through of the raw assistant message; AgentRunner pushes this into the
  // history before sending tool replies.
  assistantMessage: ChatMessage;
}

export interface LLMClient {
  modelName(): string;

  // Single-shot completion. Used by paths that don't need tools (e.g. summarization).
  invoke(prompt: string): Promise<LLMResponse>;

  // One round of a tool-calling loop. ONE HTTP call. Returns either content (done)
  // or tool_calls (more work needed). AgentRunner owns the loop.
  invokeWithTools(messages: ChatMessage[], tools: ToolDefinition[]): Promise<LLMTurnResult>;
}
