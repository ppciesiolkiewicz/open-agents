-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "allowedTokens" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Token" ADD COLUMN     "coingeckoId" TEXT;
