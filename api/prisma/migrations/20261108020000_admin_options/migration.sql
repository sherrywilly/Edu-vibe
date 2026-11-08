CREATE TABLE "AdminAccount" (
  "id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdminAccount_role_check" CHECK ("role" IN ('super_admin', 'exam_manager', 'reviewer'))
);
CREATE UNIQUE INDEX "AdminAccount_username_key" ON "AdminAccount"("username");
DELETE FROM "Session" WHERE "role" = 'admin';
ALTER TABLE "Session" ADD COLUMN "adminId" TEXT;
CREATE INDEX "Session_adminId_idx" ON "Session"("adminId");
ALTER TABLE "Session" ADD CONSTRAINT "Session_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RegistrationOption" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RegistrationOption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RegistrationOption_kind_name_key" ON "RegistrationOption"("kind", "name");
CREATE INDEX "RegistrationOption_kind_active_idx" ON "RegistrationOption"("kind", "active");
INSERT INTO "RegistrationOption" ("id", "kind", "name")
SELECT gen_random_uuid()::text, "kind", "name" FROM (
  SELECT 'school' AS "kind", trim("school") AS "name" FROM "Student"
  UNION SELECT 'district', trim("district") FROM "Student"
  UNION SELECT 'className', trim("className") FROM "Student"
  UNION SELECT 'medium', trim("medium") FROM "Student"
  UNION SELECT 'syllabus', trim("syllabus") FROM "Student"
  UNION SELECT 'className', 'Standard 4'
) AS existing WHERE "name" <> '';
