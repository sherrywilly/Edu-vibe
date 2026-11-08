ALTER TABLE "ExamSchedule"
  ADD COLUMN "durationMinutes" INTEGER,
  ADD COLUMN "eligibilityType" TEXT NOT NULL DEFAULT 'location',
  ADD COLUMN "eligibilityValue" TEXT,
  ADD COLUMN "cancelledAt" TIMESTAMP(3);

UPDATE "ExamSchedule" s SET "durationMinutes" = e."durationMinutes"
FROM "Exam" e WHERE e."id" = s."examId";
ALTER TABLE "ExamSchedule" ALTER COLUMN "durationMinutes" SET NOT NULL;
ALTER TABLE "ExamSchedule" ADD CONSTRAINT "ExamSchedule_duration_valid"
  CHECK ("durationMinutes" BETWEEN 1 AND 10080);
ALTER TABLE "ExamSchedule" ADD CONSTRAINT "ExamSchedule_eligibility_valid"
  CHECK (("eligibilityType" IN ('location', 'students') AND "eligibilityValue" IS NULL)
    OR ("eligibilityType" IN ('school', 'district') AND "eligibilityValue" IS NOT NULL AND length(trim("eligibilityValue")) > 0));
DROP INDEX "ExamSchedule_examId_locationId_key";
CREATE INDEX "ExamSchedule_examId_idx" ON "ExamSchedule"("examId");

CREATE TABLE "ExamScheduleStudent" (
  "scheduleId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  CONSTRAINT "ExamScheduleStudent_pkey" PRIMARY KEY ("scheduleId", "studentId"),
  CONSTRAINT "ExamScheduleStudent_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ExamSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ExamScheduleStudent_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ExamScheduleStudent_studentId_idx" ON "ExamScheduleStudent"("studentId");
