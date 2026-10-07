-- AlterTable
ALTER TABLE "CampaignMeta" ADD COLUMN "draftedAt" DATETIME;

-- CreateTable
CREATE TABLE "SectionConfirmation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tactplanId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "confirmedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedBy" TEXT NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CampaignContact" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tactplanId" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "value" TEXT,
    "brand" TEXT,
    "confirmedAt" DATETIME,
    "confirmedBy" TEXT,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CampaignContact" ("brand", "confirmedAt", "confirmedBy", "id", "slot", "tactplanId", "updatedAt", "value") SELECT "brand", "confirmedAt", "confirmedBy", "id", "slot", "tactplanId", "updatedAt", "value" FROM "CampaignContact";
DROP TABLE "CampaignContact";
ALTER TABLE "new_CampaignContact" RENAME TO "CampaignContact";
CREATE UNIQUE INDEX "CampaignContact_tactplanId_slot_key" ON "CampaignContact"("tactplanId", "slot");
CREATE TABLE "new_CampaignEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tactplanId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "valuesJson" TEXT NOT NULL DEFAULT '{}',
    "metadataId" TEXT,
    "autoJson" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL,
    "updatedBy" TEXT
);
INSERT INTO "new_CampaignEmail" ("id", "metadataId", "position", "tactplanId", "updatedAt", "updatedBy", "valuesJson") SELECT "id", "metadataId", "position", "tactplanId", "updatedAt", "updatedBy", "valuesJson" FROM "CampaignEmail";
DROP TABLE "CampaignEmail";
ALTER TABLE "new_CampaignEmail" RENAME TO "CampaignEmail";
CREATE INDEX "CampaignEmail_tactplanId_idx" ON "CampaignEmail"("tactplanId");
CREATE TABLE "new_JourneyTouchpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tactplanId" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "emailId" TEXT,
    "abTest" BOOLEAN NOT NULL DEFAULT false,
    "waitDays" INTEGER,
    "resendNeeded" BOOLEAN NOT NULL DEFAULT false,
    "resendRule" TEXT,
    "resendDays" INTEGER,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_JourneyTouchpoint" ("abTest", "emailId", "id", "name", "position", "resendDays", "resendNeeded", "resendRule", "segment", "tactplanId", "updatedAt", "waitDays") SELECT "abTest", "emailId", "id", "name", "position", "resendDays", "resendNeeded", "resendRule", "segment", "tactplanId", "updatedAt", "waitDays" FROM "JourneyTouchpoint";
DROP TABLE "JourneyTouchpoint";
ALTER TABLE "new_JourneyTouchpoint" RENAME TO "JourneyTouchpoint";
CREATE INDEX "JourneyTouchpoint_tactplanId_segment_idx" ON "JourneyTouchpoint"("tactplanId", "segment");
CREATE UNIQUE INDEX "JourneyTouchpoint_tactplanId_emailId_key" ON "JourneyTouchpoint"("tactplanId", "emailId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "SectionConfirmation_tactplanId_section_key" ON "SectionConfirmation"("tactplanId", "section");
