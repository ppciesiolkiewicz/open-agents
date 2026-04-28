-- Rename columns in place to preserve data. Prisma's auto-diff produced
-- a DROP+ADD pair because it cannot infer rename intent from the schema
-- delta; the rewritten ALTER below keeps existing rows intact.
ALTER TABLE "Transaction" RENAME COLUMN "from" TO "fromAddress";
ALTER TABLE "Transaction" RENAME COLUMN "to" TO "toAddress";
