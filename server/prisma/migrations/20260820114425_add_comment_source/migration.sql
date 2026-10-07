-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Comment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tactplanId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "authorPersona" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mentionsJson" TEXT,
    "source" TEXT NOT NULL DEFAULT 'human',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Comment" ("authorPersona", "body", "createdAt", "id", "mentionsJson", "sectionId", "tactplanId") SELECT "authorPersona", "body", "createdAt", "id", "mentionsJson", "sectionId", "tactplanId" FROM "Comment";
DROP TABLE "Comment";
ALTER TABLE "new_Comment" RENAME TO "Comment";
CREATE INDEX "Comment_tactplanId_sectionId_idx" ON "Comment"("tactplanId", "sectionId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
