import { EventEmitter } from 'node:events';
import type { AgentActivityLogEntry } from './types';

export type AgentActivityEvent =
  | { kind: 'append'; entry: AgentActivityLogEntry }
  | { kind: 'ephemeral'; agentId: string; payload: Record<string, unknown> };

export interface ActivityBus {
  publish(event: AgentActivityEvent): Promise<void>;
  subscribe(agentId: string, listener: (event: AgentActivityEvent) => void): () => void;
  close(): Promise<void>;
}

export class InMemoryActivityBus implements ActivityBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  async publish(event: AgentActivityEvent): Promise<void> {
    const agentId = event.kind === 'append' ? event.entry.agentId : event.agentId;
    this.emitter.emit(`agent:${agentId}`, event);
  }

  subscribe(agentId: string, listener: (event: AgentActivityEvent) => void): () => void {
    const eventName = `agent:${agentId}`;
    this.emitter.on(eventName, listener);
    return () => this.emitter.off(eventName, listener);
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}
