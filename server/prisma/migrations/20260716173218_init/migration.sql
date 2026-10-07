-- CreateTable
CREATE TABLE "BrandIndication" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "brand" TEXT NOT NULL,
    "indication" TEXT NOT NULL,
    "brandedUnbranded" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "BrandIndication_brand_indication_key" ON "BrandIndication"("brand", "indication");
