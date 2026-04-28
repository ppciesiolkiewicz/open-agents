export type TickTrigger = 'scheduled' | 'chat';

export interface TickGuardClaim {
  agentId: string;
  trigger: TickTrigger;
  startedAt: number;
}

export class TickGuard {
  private claim: TickGuardClaim | null = null;

  tryAcquire(agentId: string, trigger: TickTrigger, now: number = Date.now()): boolean {
    if (this.claim !== null) return false;
    this.claim = { agentId, trigger, startedAt: now };
    return true;
  }

  release(): void {
    this.claim = null;
  }

  current(): TickGuardClaim | null {
    return this.claim;
  }

  isBusy(): boolean {
    return this.claim !== null;
  }
}
