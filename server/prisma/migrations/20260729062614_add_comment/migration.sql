-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tactplanId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "authorPersona" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mentionsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Comment_tactplanId_sectionId_idx" ON "Comment"("tactplanId", "sectionId");
