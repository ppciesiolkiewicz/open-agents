-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "toolIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
