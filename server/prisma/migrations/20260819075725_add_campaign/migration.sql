-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "ic" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "phaseLabel" TEXT NOT NULL,
    "updated" TEXT NOT NULL,
    "daysOpen" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "indication" TEXT NOT NULL,
    "channels" TEXT NOT NULL,
    "golive" TEXT NOT NULL,
    "ready" TEXT NOT NULL,
    "fieldsResolved" TEXT NOT NULL,
    "daysToGolive" TEXT NOT NULL,
    "ownersJson" TEXT NOT NULL,
    "actionJson" TEXT NOT NULL,
    "actionTextJson" TEXT NOT NULL,
    "mineToJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
