-- DropForeignKey
ALTER TABLE "ZeroGPurchase" DROP CONSTRAINT "ZeroGPurchase_userId_fkey";

-- AddForeignKey
ALTER TABLE "ZeroGPurchase" ADD CONSTRAINT "ZeroGPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
