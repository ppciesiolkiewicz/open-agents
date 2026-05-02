import type { AxlClient } from './axl-client';
import type { TickQueue } from '../agent-runner/tick-queue';

export interface AxlPollerOptions {
  pollIntervalMs?: number;
}

export class AxlPoller {
  private running = false;

  constructor(
    private readonly axlClient: AxlClient,
    private readonly tickQueue: TickQueue,
    private readonly options: AxlPollerOptions = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    const intervalMs = this.options.pollIntervalMs ?? 100;
    while (this.running) {
      try {
        const received = await this.axlClient.recv();
        if (!received) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }
        await this.tickQueue.enqueue({
          trigger: 'chat',
          agentId: received.message.targetAgentId,
          chatContent: received.message.chatContent,
        });
      } catch (err) {
        console.error('[axl-poller] error:', err);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }
}
