import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AgentTool } from './tool';
import type { ToolDefinition } from '../agent-runner/llm-client';

// AgentTool → ToolDefinition (the LLM-facing descriptor).
// JSON Schema generation runs once per build of the tool list (per-tick).
export function toToolDefinition(tool: AgentTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parametersSchema: tool.inputSchema,
  };
}

// Convenience for callers that already need the OpenAI-shaped JSON schema
// (e.g. the smoke test that asserts the tool surface is well-formed).
export function toOpenAIFunctionSchema(tool: AgentTool): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  return {
    name: tool.name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.inputSchema, { target: 'openApi3' }) as Record<string, unknown>,
  };
}
