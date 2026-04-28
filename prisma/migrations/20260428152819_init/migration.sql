-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL,
    "dryRunSeedBalances" JSONB,
    "riskLimits" JSONB NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "running" BOOLEAN,
    "intervalMs" INTEGER,
    "lastTickAt" BIGINT,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "tokenIn" JSONB,
    "tokenOut" JSONB,
    "gasUsed" TEXT NOT NULL,
    "gasPriceWei" TEXT NOT NULL,
    "gasCostWei" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "blockNumber" BIGINT,
    "timestamp" BIGINT NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "amount" JSONB NOT NULL,
    "costBasisUSD" DOUBLE PRECISION NOT NULL,
    "openedByTransactionId" TEXT NOT NULL,
    "closedByTransactionId" TEXT,
    "openedAt" BIGINT NOT NULL,
    "closedAt" BIGINT,
    "realizedPnlUSD" DOUBLE PRECISION,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMemory" (
    "agentId" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "state" JSONB NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("agentId")
);

-- CreateTable
CREATE TABLE "MemoryEntry" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "tickId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "parentEntryIds" TEXT[],
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "MemoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "tickId" TEXT,
    "type" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "seq" BIGSERIAL NOT NULL,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Transaction_agentId_timestamp_idx" ON "Transaction"("agentId", "timestamp");

-- CreateIndex
CREATE INDEX "Position_agentId_closedAt_idx" ON "Position"("agentId", "closedAt");

-- CreateIndex
CREATE INDEX "MemoryEntry_agentId_createdAt_idx" ON "MemoryEntry"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryEntry_agentId_tickId_idx" ON "MemoryEntry"("agentId", "tickId");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityEvent_seq_key" ON "ActivityEvent"("seq");

-- CreateIndex
CREATE INDEX "ActivityEvent_agentId_timestamp_idx" ON "ActivityEvent"("agentId", "timestamp");

-- CreateIndex
CREATE INDEX "ActivityEvent_agentId_tickId_idx" ON "ActivityEvent"("agentId", "tickId");

-- CreateIndex
CREATE INDEX "ActivityEvent_agentId_seq_idx" ON "ActivityEvent"("agentId", "seq");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMemory" ADD CONSTRAINT "AgentMemory_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryEntry" ADD CONSTRAINT "MemoryEntry_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentMemory"("agentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
