import type { TickQueue, TickQueueConsumer } from '../agent-runner/tick-queue';

/** Test-only TickQueue stub; enqueue is a no-op. */
export function createStubTickQueue(): TickQueue {
  const noopConsumer: TickQueueConsumer = {
    next: async () => null,
    stop: async () => {},
  };
  return {
    enqueue: async () => ({ position: 0 }),
    hasScheduledFor: async () => false,
    snapshot: async () => ({ current: null, pending: [] }),
    consume: () => noopConsumer,
  };
}
