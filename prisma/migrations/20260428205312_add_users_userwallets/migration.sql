/*
  Warnings:

  - Added the required column `userId` to the `Agent` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "userId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "privyDid" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "privyWalletId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "UserWallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_privyDid_key" ON "User"("privyDid");

-- CreateIndex
CREATE UNIQUE INDEX "UserWallet_privyWalletId_key" ON "UserWallet"("privyWalletId");

-- CreateIndex
CREATE INDEX "UserWallet_userId_idx" ON "UserWallet"("userId");

-- CreateIndex
CREATE INDEX "UserWallet_userId_isPrimary_idx" ON "UserWallet"("userId", "isPrimary");

-- CreateIndex
CREATE INDEX "Agent_userId_idx" ON "Agent"("userId");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserWallet" ADD CONSTRAINT "UserWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
