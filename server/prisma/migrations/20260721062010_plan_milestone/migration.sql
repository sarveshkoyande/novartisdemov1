-- CreateTable
CREATE TABLE "PlanMilestone" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tactplanId" TEXT NOT NULL,
    "discoveryEta" TEXT,
    "cpfEta" TEXT,
    "crfEta" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanMilestone_tactplanId_key" ON "PlanMilestone"("tactplanId");
