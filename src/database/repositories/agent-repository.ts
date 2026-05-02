import type { AgentConfig, AxlChannel } from '../types';

export interface AgentRepository {
  list(): Promise<AgentConfig[]>;
  listByUser(userId: string): Promise<AgentConfig[]>;
  findById(id: string): Promise<AgentConfig | null>;
  upsert(agent: AgentConfig): Promise<void>;
  setAxlConnections(agentId: string, connectedAgentIds: string[]): Promise<void>;
  createAxlChannel(input: { id: string; userId: string; name: string; createdAt: number }): Promise<AxlChannel>;
  listAxlChannelsByUser(userId: string): Promise<AxlChannel[]>;
  findAxlChannelById(channelId: string): Promise<AxlChannel | null>;
  deleteAxlChannel(channelId: string): Promise<void>;
  addAgentToAxlChannel(agentId: string, channelId: string): Promise<void>;
  removeAgentFromAxlChannel(agentId: string, channelId: string): Promise<void>;
  stampAxlPeerId(peerId: string): Promise<void>;
  delete(id: string): Promise<void>;
}
