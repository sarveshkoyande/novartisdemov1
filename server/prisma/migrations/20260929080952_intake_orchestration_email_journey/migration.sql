-- CreateTable
CREATE TABLE "CampaignMeta" (
    "tactplanId" TEXT NOT NULL PRIMARY KEY,
    "brandCode" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BrandContact" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "brand" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "value" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "CampaignContact" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tactplanId" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "value" TEXT,
    "brand" TEXT,
    "confirmedAt" DATETIME,
    "confirmedBy" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TriggerFiring" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tactplanId" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "firedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" DATETIME,
    "doneBy" TEXT,
    "flaggedJson" TEXT
);

-- CreateTable
CREATE TABLE "CampaignEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tactplanId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "valuesJson" TEXT NOT NULL DEFAULT '{}',
    "metadataId" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "updatedBy" TEXT
);

-- CreateTable
CREATE TABLE "JourneyTouchpoint" (
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
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "BrandContact_brand_slot_key" ON "BrandContact"("brand", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignContact_tactplanId_slot_key" ON "CampaignContact"("tactplanId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "TriggerFiring_tactplanId_triggerId_key" ON "TriggerFiring"("tactplanId", "triggerId");

-- CreateIndex
CREATE INDEX "CampaignEmail_tactplanId_idx" ON "CampaignEmail"("tactplanId");

-- CreateIndex
CREATE INDEX "JourneyTouchpoint_tactplanId_segment_idx" ON "JourneyTouchpoint"("tactplanId", "segment");

-- CreateIndex
CREATE UNIQUE INDEX "JourneyTouchpoint_tactplanId_emailId_key" ON "JourneyTouchpoint"("tactplanId", "emailId");
