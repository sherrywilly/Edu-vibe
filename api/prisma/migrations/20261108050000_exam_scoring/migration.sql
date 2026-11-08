ALTER TABLE "Exam" ADD COLUMN "passingScore" INTEGER;
ALTER TABLE "ExamQuestion"
  ADD COLUMN "subject" TEXT NOT NULL DEFAULT 'General',
  ADD COLUMN "marks" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "negativeMarks" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_passingScore_check"
  CHECK ("passingScore" IS NULL OR "passingScore" >= 0);
ALTER TABLE "ExamQuestion" ADD CONSTRAINT "ExamQuestion_scoring_check"
  CHECK (length(trim("subject")) BETWEEN 1 AND 200 AND "marks" > 0 AND "negativeMarks" >= 0);
