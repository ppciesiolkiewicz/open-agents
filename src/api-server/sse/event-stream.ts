import type { Response } from 'express';

const KEEPALIVE_INTERVAL_MS = 15_000;

export class SseWriter {
  private keepalive: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    this.keepalive = setInterval(() => {
      if (this.closed) return;
      try {
        res.write(': keep-alive\n\n');
      } catch {
        this.close();
      }
    }, KEEPALIVE_INTERVAL_MS);
    res.on('close', () => this.close());
  }

  send(event: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepalive) clearInterval(this.keepalive);
    try {
      this.res.end();
    } catch {
      // ignored
    }
  }

  isClosed(): boolean {
    return this.closed;
  }
}
