import type { Database } from '../database/database';
import type { AgentRunner } from '../agent-runner/agent-runner';
import type { AgentActivityLog } from '../database/agent-activity-log';
import type { TickQueue, TickQueueConsumer } from '../agent-runner/tick-queue';
import { ChatTickStrategy } from '../agent-runner/tick-strategies/chat-tick-strategy';
import type { TickPayload } from '../agent-runner/tick-queue-payload';

export interface TickDispatcherDeps {
  db: Database;
  runner: AgentRunner;
  activityLog: AgentActivityLog;
  queue: TickQueue;
}

export class TickDispatcher {
  private consumer: TickQueueConsumer | null = null;
  private running = false;
  private dispatching = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly deps: TickDispatcherDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.consumer = this.deps.queue.consume();
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.consumer) await this.consumer.stop();
    await this.drain();
  }

  async drain(): Promise<void> {
    if (await this.isIdle()) return;
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private async isIdle(): Promise<boolean> {
    if (this.dispatching) return false;
    const snap = await this.deps.queue.snapshot();
    return snap.pending.length === 0 && snap.current === null;
  }

  private async loop(): Promise<void> {
    while (this.running && this.consumer) {
      const payload = await this.consumer.next();
      if (!payload) break;
      this.dispatching = true;
      this.deps.queue.markStarted?.(payload);
      try {
        await this.dispatch(payload);
      } catch (err) {
        console.error(`[dispatcher] payload for agent=${payload.agentId} trigger=${payload.trigger} threw:`, err);
      } finally {
        this.deps.queue.markFinished?.(payload);
        this.dispatching = false;
        if (await this.isIdle()) this.flushIdleWaiters();
      }
    }
    this.flushIdleWaiters();
  }

  private flushIdleWaiters(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private async dispatch(payload: TickPayload): Promise<void> {
    const agent = await this.deps.db.agents.findById(payload.agentId);
    if (!agent) {
      console.warn(`[dispatcher] payload references unknown agent=${payload.agentId}; dropping`);
      return;
    }
    const log = this.deps.activityLog;
    const onToken = (text: string) => log.emitEphemeral(payload.agentId, { type: 'token', text });
    if (payload.trigger === 'chat') {
      const strategy = new ChatTickStrategy(log, payload.chatContent);
      await this.deps.runner.run(agent, strategy, { onToken });
    } else {
      await this.deps.runner.run(agent, undefined, { onToken });
    }
  }
}
