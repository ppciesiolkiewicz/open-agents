import type { Database } from '../database/database';
import type { AgentRunner, Clock } from '../agent-runner/agent-runner';
import { TickGuard } from '../agent-runner/tick-guard';

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export class AgentOrchestrator {
  constructor(
    private readonly db: Database,
    private readonly runner: AgentRunner,
    private readonly tickGuard: TickGuard,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  async tick(): Promise<void> {
    const now = this.clock.now();
    const all = await this.db.agents.list();
    const due = all.filter(
      (a) => a.running === true && (a.intervalMs ?? 0) > 0 && now - (a.lastTickAt ?? 0) >= (a.intervalMs ?? 0),
    );

    for (const agent of due) {
      if (!this.tickGuard.tryAcquire(agent.id, 'scheduled')) continue;
      try {
        await this.runner.run(agent);
      } catch (err) {
        // isolation: one agent failure must not abort the loop
        console.error(`[orchestrator] agent ${agent.id} threw:`, err);
      } finally {
        this.tickGuard.release();
      }
    }
  }
}
