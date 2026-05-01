-- CreateTable
CREATE TABLE "AxlChannel" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "AxlChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AxlChannelMembership" (
    "channelId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "AxlChannelMembership_pkey" PRIMARY KEY ("channelId","agentId")
);

-- CreateIndex
CREATE INDEX "AxlChannel_userId_idx" ON "AxlChannel"("userId");

-- CreateIndex
CREATE INDEX "AxlChannelMembership_agentId_idx" ON "AxlChannelMembership"("agentId");

-- AddForeignKey
ALTER TABLE "AxlChannel" ADD CONSTRAINT "AxlChannel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AxlChannelMembership" ADD CONSTRAINT "AxlChannelMembership_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "AxlChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AxlChannelMembership" ADD CONSTRAINT "AxlChannelMembership_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
