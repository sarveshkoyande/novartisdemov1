-- CreateTable
CREATE TABLE "FieldEntry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tactplanId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "sectionName" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "fieldLabel" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "FieldEntry_tactplanId_phase_idx" ON "FieldEntry"("tactplanId", "phase");

-- CreateIndex
CREATE UNIQUE INDEX "FieldEntry_tactplanId_sectionId_fieldId_key" ON "FieldEntry"("tactplanId", "sectionId", "fieldId");
