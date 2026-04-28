import type { Database } from '../database/database';
import type { AgentConfig, AgentMemory } from '../database/types';
import type { AgentActivityLog } from '../agent-activity-log/agent-activity-log';
import type { WalletFactory } from '../wallet/factory/wallet-factory';
import type { ToolRegistry } from '../ai-tools/tool-registry';
import type { AgentTool, AgentToolContext } from '../ai-tools/tool';
import { toToolDefinition } from '../ai-tools/zod-to-openai';
import { AGENT_RUNNER } from '../constants';
import type { ChatMessage, LLMClient, ToolCall, ToolDefinition } from './llm-client';
import type { TickStrategy } from './tick-strategies/tick-strategy';
import { ScheduledTickStrategy } from './tick-strategies/scheduled-tick-strategy';

export interface Clock {
  now(): number;
}

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export class AgentRunner {
  private readonly defaultStrategy: TickStrategy;

  constructor(
    private readonly db: Database,
    private readonly activityLog: AgentActivityLog,
    private readonly walletFactory: WalletFactory,
    private readonly llm: LLMClient,
    private readonly toolRegistry: ToolRegistry,
    private readonly clock: Clock = SYSTEM_CLOCK,
    defaultStrategy: TickStrategy = new ScheduledTickStrategy(),
  ) {
    this.defaultStrategy = defaultStrategy;
  }

  async run(
    agent: AgentConfig,
    strategy: TickStrategy = this.defaultStrategy,
    options: { onToken?: (text: string) => void } = {},
  ): Promise<void> {
    const tickId = `${agent.id}-${this.clock.now()}`;
    try {
      const memory = await this.loadOrInitMemory(agent.id);
      const systemPrompt = this.buildSystemPrompt(agent, memory);
      const { userMessageContent, initialMessages } = await strategy.buildInitialMessages({
        agent, memory, systemPrompt,
      });

      await this.activityLog.userMessage(agent.id, tickId, { content: userMessageContent });
      await this.activityLog.tickStart(agent.id, tickId);
      this.logStdout(agent.id, `tick start (tickId=${tickId})`);

      const wallet = this.walletFactory.forAgent(agent);
      const tools = this.toolRegistry.build();
      const toolByName = new Map(tools.map((t) => [t.name, t]));
      const toolDefs = tools.map(toToolDefinition);
      const ctx: AgentToolContext = { agent, wallet, tickId };

      await this.runToolLoop(agent, tickId, initialMessages, toolDefs, toolByName, ctx, options);
    } catch (err) {
      const e = err as Error;
      this.logStdout(agent.id, `ERROR ${e.message}`);
      try {
        await this.activityLog.error(agent.id, tickId, { message: e.message, stack: e.stack });
        await this.activityLog.tickEnd(agent.id, tickId, { ok: false });
      } catch { /* ignore */ }
      throw err;
    } finally {
      await this.db.agents.upsert({ ...agent, lastTickAt: this.clock.now() });
    }
  }

  private async runToolLoop(
    agent: AgentConfig,
    tickId: string,
    messages: ChatMessage[],
    toolDefs: ToolDefinition[],
    toolByName: Map<string, AgentTool>,
    ctx: AgentToolContext,
    options: { onToken?: (text: string) => void } = {},
  ): Promise<void> {
    let rounds = 0;
    while (rounds < AGENT_RUNNER.maxToolRoundsPerTick) {
      rounds++;
      const promptChars = messages.reduce((sum, m) => {
        let chars = m.content.length;
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          chars += JSON.stringify(m.toolCalls).length;
        }
        return sum + chars;
      }, 0);
      await this.activityLog.llmCall(agent.id, tickId, { model: this.llm.modelName(), promptChars });
      this.logStdout(agent.id, `llm_call round=${rounds} model=${this.llm.modelName()} promptChars=${promptChars}`);

      const turn = await this.llm.invokeWithTools(
        messages,
        toolDefs,
        options.onToken ? { onToken: options.onToken } : undefined,
      );

      await this.activityLog.llmResponse(agent.id, tickId, {
        model: this.llm.modelName(),
        responseChars: (turn.content ?? '').length,
        ...(turn.tokenCount !== undefined ? { tokenCount: turn.tokenCount } : {}),
        content: turn.content ?? '',
        ...(turn.toolCalls && turn.toolCalls.length > 0
          ? { toolCalls: turn.toolCalls.map((c) => ({ id: c.id, name: c.name, argumentsJson: c.argumentsJson })) }
          : {}),
      });

      const reasoning = (turn.content ?? '').trim();
      if (reasoning) this.logStdout(agent.id, `reasoning: ${truncate(reasoning, 600)}`);
      this.logStdout(
        agent.id,
        turn.toolCalls && turn.toolCalls.length > 0
          ? `llm_response toolCalls=[${turn.toolCalls.map((c) => c.name).join(', ')}]`
          : `llm_response toolCalls=[] (final answer)`,
      );

      messages.push(turn.assistantMessage);

      if (!turn.toolCalls || turn.toolCalls.length === 0) {
        await this.activityLog.tickEnd(agent.id, tickId, {
          ok: true, rounds, responseChars: (turn.content ?? '').length,
        });
        this.logStdout(agent.id, `tick end ok=true rounds=${rounds}`);
        return;
      }

      for (const call of turn.toolCalls) {
        const reply = await this.dispatchToolCall(agent.id, tickId, call, toolByName, ctx);
        messages.push(reply);
      }
    }

    await this.activityLog.error(agent.id, tickId, {
      message: `exceeded ${AGENT_RUNNER.maxToolRoundsPerTick} tool-call rounds`,
    });
    await this.activityLog.tickEnd(agent.id, tickId, { ok: false, rounds });
    this.logStdout(agent.id, `tick end ok=false rounds=${rounds} (exceeded maxToolRoundsPerTick)`);
  }

  private async dispatchToolCall(
    agentId: string,
    tickId: string,
    call: ToolCall,
    toolByName: Map<string, AgentTool>,
    ctx: AgentToolContext,
  ): Promise<ChatMessage> {
    const tool = toolByName.get(call.name);
    if (!tool) {
      const errMsg = `unknown tool: ${call.name}`;
      await this.activityLog.toolCall(agentId, tickId, { id: call.id, tool: call.name, input: call.argumentsJson });
      await this.activityLog.error(agentId, tickId, { tool: call.name, message: errMsg });
      return { role: 'tool', toolCallId: call.id, content: `error: ${errMsg}` };
    }

    let parsed: unknown;
    try {
      parsed = tool.inputSchema.parse(JSON.parse(call.argumentsJson));
    } catch (err) {
      const errMsg = `invalid tool input: ${(err as Error).message}`;
      await this.activityLog.toolCall(agentId, tickId, { id: call.id, tool: call.name, input: call.argumentsJson });
      await this.activityLog.error(agentId, tickId, { tool: call.name, message: errMsg });
      return { role: 'tool', toolCallId: call.id, content: `error: ${errMsg}` };
    }

    await this.activityLog.toolCall(agentId, tickId, { id: call.id, tool: call.name, input: parsed });
    this.logStdout(agentId, `tool_call ${call.name} input=${truncate(JSON.stringify(parsed), 400)}`);
    const start = this.clock.now();
    try {
      const output = await tool.invoke(parsed, ctx);
      const durationMs = this.clock.now() - start;
      await this.activityLog.toolResult(agentId, tickId, {
        id: call.id,
        tool: call.name,
        output,
        durationMs,
      });
      this.logStdout(
        agentId,
        `tool_result ${call.name} (${durationMs}ms) output=${truncate(JSON.stringify(output), 400)}`,
      );
      if (call.name === 'updateMemory' || call.name === 'saveMemoryEntry') {
        const memPayload = this.memoryUpdatePayload(call.name, parsed);
        await this.activityLog.memoryUpdate(agentId, tickId, memPayload);
        this.logStdoutMemory(agentId, memPayload);
      }
      return { role: 'tool', toolCallId: call.id, content: JSON.stringify(output) };
    } catch (err) {
      const errMsg = (err as Error).message;
      const durationMs = this.clock.now() - start;
      await this.activityLog.error(agentId, tickId, { tool: call.name, message: errMsg });
      await this.activityLog.toolResult(agentId, tickId, {
        id: call.id,
        tool: call.name,
        output: `error: ${errMsg}`,
        durationMs,
      });
      this.logStdout(agentId, `tool_error ${call.name} (${durationMs}ms) ${errMsg}`);
      return { role: 'tool', toolCallId: call.id, content: `error: ${errMsg}` };
    }
  }

  private logStdout(agentId: string, msg: string): void {
    console.log(`[agent:${agentId}] ${msg}`);
  }

  private logStdoutMemory(
    agentId: string,
    payload: ReturnType<AgentRunner['memoryUpdatePayload']>,
  ): void {
    if (payload.tool === 'updateMemory') {
      const parts: string[] = [];
      if (payload.state) parts.push(`state=${truncate(JSON.stringify(payload.state), 300)}`);
      if (payload.appendNote) parts.push(`note="${truncate(payload.appendNote, 200)}"`);
      this.logStdout(agentId, `memory_update updateMemory ${parts.join(' ')}`);
    } else {
      const e = payload.entry;
      this.logStdout(
        agentId,
        `memory_update saveMemoryEntry type=${e?.type} content="${truncate(e?.content ?? '', 200)}"`,
      );
    }
  }

  private buildSystemPrompt(agent: AgentConfig, memory: AgentMemory): string {
    return [
      agent.prompt,
      '',
      'You have tools available — see the function-calling schema. Use them to gather information.',
      'Use saveMemoryEntry at the end of each tick to record what you learned and what you decided. Use updateMemory to overwrite your structured state when it changes.',
      '',
      'Current memory state:',
      JSON.stringify(memory.state, null, 2),
      '',
      'Current memory notes:',
      memory.notes || '(empty)',
      '',
      `Recent memory entries (last ${Math.min(5, memory.entries.length)}):`,
      memory.entries.length === 0
        ? '(none yet)'
        : JSON.stringify(memory.entries.slice(-5), null, 2),
    ].join('\n');
  }

  private async loadOrInitMemory(agentId: string): Promise<AgentMemory> {
    const existing = await this.db.agentMemory.get(agentId);
    if (existing) return existing;
    return {
      agentId,
      notes: '',
      state: {},
      updatedAt: this.clock.now(),
      entries: [],
    };
  }

  private memoryUpdatePayload(
    toolName: string,
    input: unknown,
  ): {
    tool: 'updateMemory' | 'saveMemoryEntry';
    keysChanged: string[];
    state?: Record<string, unknown>;
    appendNote?: string;
    entry?: { type: string; content: string; parentEntryIds?: string[] };
  } {
    const i = input as {
      state?: Record<string, unknown>;
      appendNote?: string;
      type?: string;
      content?: string;
      parentEntryIds?: string[];
    };
    if (toolName === 'updateMemory') {
      const keysChanged: string[] = [];
      if (i.state) keysChanged.push(...Object.keys(i.state).map((k) => `state.${k}`));
      if (i.appendNote) keysChanged.push('notes');
      return {
        tool: 'updateMemory',
        keysChanged,
        ...(i.state ? { state: i.state } : {}),
        ...(i.appendNote ? { appendNote: i.appendNote } : {}),
      };
    }
    return {
      tool: 'saveMemoryEntry',
      keysChanged: [`entries[type=${i.type ?? 'unknown'}]`],
      entry: {
        type: i.type ?? 'unknown',
        content: i.content ?? '',
        ...(i.parentEntryIds && i.parentEntryIds.length > 0
          ? { parentEntryIds: i.parentEntryIds }
          : {}),
      },
    };
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max} chars)`;
}
