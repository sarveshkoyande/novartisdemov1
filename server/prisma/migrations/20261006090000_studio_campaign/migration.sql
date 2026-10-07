-- CreateTable
CREATE TABLE "StudioCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "brand" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "stage" TEXT NOT NULL DEFAULT 'upload',
    "stateJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
