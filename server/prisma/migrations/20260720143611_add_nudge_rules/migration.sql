-- CreateTable
CREATE TABLE "NudgeRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trigger" TEXT NOT NULL,
    "triggerSectionId" TEXT,
    "triggerPhase" TEXT,
    "triggerFieldDrives" TEXT,
    "triggerValue" TEXT,
    "message" TEXT NOT NULL,
    "nudgeMessage" TEXT,
    "nudgeToOwner" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL
);
