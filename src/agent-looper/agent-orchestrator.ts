import type { Database } from '../database/database';
import type { AgentRunner, Clock } from '../agent-runner/agent-runner';

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export class AgentOrchestrator {
  constructor(
    private readonly db: Database,
    private readonly runner: AgentRunner,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  async tick(): Promise<void> {
    const now = this.clock.now();
    const all = await this.db.agents.list();
    const due = all.filter(
      (a) => a.enabled && now - (a.lastTickAt ?? 0) >= a.intervalMs,
    );

    for (const agent of due) {
      try {
        await this.runner.run(agent);
      } catch (err) {
        console.error(`[orchestrator] agent ${agent.id} threw:`, err);
      }
    }
  }
}
