-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BrandIndication" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "brand" TEXT NOT NULL,
    "indication" TEXT NOT NULL,
    "brandedUnbranded" TEXT NOT NULL,
    "therapeuticArea" TEXT NOT NULL DEFAULT ''
);
INSERT INTO "new_BrandIndication" ("brand", "brandedUnbranded", "id", "indication") SELECT "brand", "brandedUnbranded", "id", "indication" FROM "BrandIndication";
DROP TABLE "BrandIndication";
ALTER TABLE "new_BrandIndication" RENAME TO "BrandIndication";
CREATE UNIQUE INDEX "BrandIndication_brand_indication_key" ON "BrandIndication"("brand", "indication");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
