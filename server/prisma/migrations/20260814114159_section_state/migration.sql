-- CreateTable
CREATE TABLE "SectionState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tactplanId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "submitted" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "SectionState_tactplanId_sectionId_key" ON "SectionState"("tactplanId", "sectionId");
