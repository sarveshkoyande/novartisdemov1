/*
  Warnings:

  - You are about to drop the `Agency` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AgencyBrandAccess` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "AppUser" ADD COLUMN "organization" TEXT;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Agency";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AgencyBrandAccess";
PRAGMA foreign_keys=on;
