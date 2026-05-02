import type { AxlClient } from './axl-client';
import type { TickQueue } from '../agent-runner/tick-queue';
import { WORKER } from '../constants';

export interface AxlPollerOptions {
  pollIntervalMs?: number;
}

export class AxlPoller {
  private running = false;
  private abortController: AbortController | null = null;

  constructor(
    private readonly axlClient: AxlClient,
    private readonly tickQueue: TickQueue,
    private readonly options: AxlPollerOptions = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    void this.loop(this.abortController.signal);
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    const minIntervalMs = this.options.pollIntervalMs ?? WORKER.axlPollIntervalMs;
    const maxBackoffMs = 30_000;
    let backoffMs = minIntervalMs;

    while (this.running) {
      try {
        const received = await this.axlClient.recv(signal);
        if (!received) {
          await new Promise((resolve) => setTimeout(resolve, minIntervalMs));
          continue;
        }
        backoffMs = minIntervalMs;
        await this.tickQueue.enqueue({
          trigger: 'chat',
          agentId: received.message.targetAgentId,
          chatContent: received.message.chatContent,
        });
      } catch (err) {
        if (signal.aborted) break;
        console.error('[axl-poller] error:', err);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      }
    }
  }
}
