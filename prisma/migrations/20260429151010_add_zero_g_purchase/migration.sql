-- CreateTable
CREATE TABLE "ZeroGPurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userWalletAddress" TEXT NOT NULL,
    "incomingTxHash" TEXT NOT NULL,
    "incomingUsdcAmount" BIGINT NOT NULL,
    "serviceFeeUsdcAmount" BIGINT NOT NULL,
    "swapInputUsdcAmount" BIGINT NOT NULL,
    "bridgeTxHash" TEXT,
    "bridgeGasCostWei" BIGINT,
    "swapTxHash" TEXT,
    "swapInputUsdceAmount" BIGINT,
    "swapOutputW0gAmount" BIGINT,
    "swapGasCostWei" BIGINT,
    "unwrapTxHash" TEXT,
    "unwrapGasCostWei" BIGINT,
    "unwrappedOgAmount" BIGINT,
    "sendTxHash" TEXT,
    "sendGasCostWei" BIGINT,
    "ogAmountSentToUser" BIGINT,
    "ledgerTopUpTxHash" TEXT,
    "ledgerTopUpGasCostWei" BIGINT,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "ZeroGPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ZeroGPurchase_incomingTxHash_key" ON "ZeroGPurchase"("incomingTxHash");

-- CreateIndex
CREATE INDEX "ZeroGPurchase_userId_idx" ON "ZeroGPurchase"("userId");

-- CreateIndex
CREATE INDEX "ZeroGPurchase_userWalletAddress_idx" ON "ZeroGPurchase"("userWalletAddress");

-- AddForeignKey
ALTER TABLE "ZeroGPurchase" ADD CONSTRAINT "ZeroGPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
