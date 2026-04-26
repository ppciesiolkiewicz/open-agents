import type { Position } from '../types';

export interface PositionRepository {
  insert(pos: Position): Promise<void>;
  findOpen(agentId: string, tokenAddress: string): Promise<Position | null>;
  listByAgent(agentId: string): Promise<Position[]>;
  update(pos: Position): Promise<void>;
}
