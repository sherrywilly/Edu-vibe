ALTER TABLE "Exam"
  ADD COLUMN "shuffleQuestions" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "shuffleOptions" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ExamAttempt"
  ADD COLUMN "randomizationLayout" JSONB,
  ADD CONSTRAINT "ExamAttempt_randomizationLayout_object"
    CHECK ("randomizationLayout" IS NULL OR jsonb_typeof("randomizationLayout") = 'object');
