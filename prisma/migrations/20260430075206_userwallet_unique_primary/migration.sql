-- Demote duplicate primaries (keep oldest createdAt per user) so the new
-- partial unique index can be created without conflicts.
UPDATE "UserWallet" SET "isPrimary" = false
WHERE "id" NOT IN (
  SELECT DISTINCT ON ("userId") "id"
  FROM "UserWallet"
  WHERE "isPrimary" = true
  ORDER BY "userId", "createdAt" ASC
)
AND "isPrimary" = true;

-- One primary wallet per user, enforced at the DB.
CREATE UNIQUE INDEX "UserWallet_userId_primary_unique"
ON "UserWallet" ("userId")
WHERE "isPrimary" = true;
