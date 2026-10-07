-- CreateTable
CREATE TABLE "TacticFieldTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tacticType" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "bucket" TEXT,
    "source" TEXT,
    "optionsJson" TEXT,
    "condJson" TEXT,
    "drives" TEXT,
    "cascadeFromField" TEXT,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "lockedValue" TEXT,
    "wide" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL
);

-- CreateIndex
CREATE INDEX "TacticFieldTemplate_tacticType_idx" ON "TacticFieldTemplate"("tacticType");
