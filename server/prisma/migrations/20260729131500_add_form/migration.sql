-- CreateTable
CREATE TABLE "Form" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL
);

-- Seed the default Form so existing sections have somewhere to attach —
-- the app's whole current section set becomes this one Form's content.
INSERT INTO "Form" ("id", "name", "description", "active", "order")
VALUES ('form-default', 'Requirement Gathering Form', 'The original campaign requirement-gathering flow.', true, 0);

-- RedefineTable: SQLite can''t ALTER a column to add a NOT NULL foreign key
-- onto a table that already has rows without a rebuild, so this rebuilds
-- FormSection with the new formId column, backfilling every existing row
-- to the default Form created above.
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FormSection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "formId" TEXT NOT NULL,
    "num" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "parentId" TEXT,
    "audienceGate" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "needsJson" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    CONSTRAINT "FormSection_formId_fkey" FOREIGN KEY ("formId") REFERENCES "Form" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_FormSection" ("id", "formId", "num", "name", "icon", "parentId", "audienceGate", "note", "needsJson", "order")
SELECT "id", 'form-default', "num", "name", "icon", "parentId", "audienceGate", "note", "needsJson", "order" FROM "FormSection";
DROP TABLE "FormSection";
ALTER TABLE "new_FormSection" RENAME TO "FormSection";
CREATE INDEX "FormSection_formId_idx" ON "FormSection"("formId");
PRAGMA foreign_keys=ON;
