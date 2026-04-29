-- CreateTable
CREATE TABLE "Token" (
    "id" SERIAL NOT NULL,
    "chainId" INTEGER NOT NULL,
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "logoUri" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Token_chainId_idx" ON "Token"("chainId");

-- CreateIndex
CREATE UNIQUE INDEX "Token_address_chainId_key" ON "Token"("address", "chainId");
