import type { Database } from '../database/database';
import type { Clock } from '../agent-runner/agent-runner';
import type { TickQueue } from '../agent-runner/tick-queue';

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export class AgentOrchestrator {
  constructor(
    private readonly db: Database,
    private readonly queue: TickQueue,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  async tick(): Promise<void> {
    const now = this.clock.now();
    const all = await this.db.agents.list();
    const due = all.filter(
      (a) => a.running === true && (a.intervalMs ?? 0) > 0 && now - (a.lastTickAt ?? 0) >= (a.intervalMs ?? 0),
    );

    for (const agent of due) {
      if (await this.queue.hasScheduledFor(agent.id)) continue;
      // optimistic lastTickAt bump prevents the next scheduler iteration from
      // re-enqueuing the same agent while this scheduled tick is still pending.
      await this.db.agents.upsert({ ...agent, lastTickAt: now });
      await this.queue.enqueue({ trigger: 'scheduled', agentId: agent.id });
    }
  }
}
