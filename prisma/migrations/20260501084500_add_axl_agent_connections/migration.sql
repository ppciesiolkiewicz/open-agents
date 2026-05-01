-- CreateTable
CREATE TABLE "AxlAgentConnection" (
    "agentAId" TEXT NOT NULL,
    "agentBId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "AxlAgentConnection_pkey" PRIMARY KEY ("agentAId","agentBId")
);

-- CreateIndex
CREATE INDEX "AxlAgentConnection_agentAId_idx" ON "AxlAgentConnection"("agentAId");

-- CreateIndex
CREATE INDEX "AxlAgentConnection_agentBId_idx" ON "AxlAgentConnection"("agentBId");

-- AddForeignKey
ALTER TABLE "AxlAgentConnection" ADD CONSTRAINT "AxlAgentConnection_agentAId_fkey" FOREIGN KEY ("agentAId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AxlAgentConnection" ADD CONSTRAINT "AxlAgentConnection_agentBId_fkey" FOREIGN KEY ("agentBId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
