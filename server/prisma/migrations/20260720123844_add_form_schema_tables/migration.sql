-- CreateTable
CREATE TABLE "FormSection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "num" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "parentId" TEXT,
    "audienceGate" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "needsJson" TEXT NOT NULL,
    "order" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "FormField" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sectionId" TEXT NOT NULL,
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
    "order" INTEGER NOT NULL,
    CONSTRAINT "FormField_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "FormSection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FormField_sectionId_idx" ON "FormField"("sectionId");
