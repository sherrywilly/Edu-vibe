CREATE TABLE "Exam" (
  "id" TEXT NOT NULL, "title" TEXT NOT NULL, "durationMinutes" INTEGER NOT NULL,
  "resultsPublished" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Exam_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Exam_duration_positive" CHECK ("durationMinutes" > 0)
);
CREATE TABLE "ExamQuestion" (
  "id" TEXT NOT NULL, "examId" TEXT NOT NULL, "position" INTEGER NOT NULL,
  "prompt" TEXT NOT NULL, "options" JSONB NOT NULL, "correctOption" INTEGER NOT NULL,
  CONSTRAINT "ExamQuestion_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ExamSchedule" (
  "id" TEXT NOT NULL, "examId" TEXT NOT NULL, "locationId" TEXT NOT NULL,
  "opensAt" TIMESTAMP(3) NOT NULL, "closesAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExamSchedule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExamSchedule_valid_window" CHECK ("opensAt" < "closesAt")
);
CREATE TABLE "ExamAttempt" (
  "id" TEXT NOT NULL, "examId" TEXT NOT NULL, "studentId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL, "deadline" TIMESTAMP(3) NOT NULL,
  "submittedAt" TIMESTAMP(3), "revision" INTEGER NOT NULL DEFAULT 0, "score" INTEGER,
  CONSTRAINT "ExamAttempt_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ExamAnswer" (
  "attemptId" TEXT NOT NULL, "questionId" TEXT NOT NULL, "option" INTEGER NOT NULL,
  CONSTRAINT "ExamAnswer_pkey" PRIMARY KEY ("attemptId", "questionId")
);
CREATE UNIQUE INDEX "ExamQuestion_examId_position_key" ON "ExamQuestion"("examId", "position");
CREATE UNIQUE INDEX "ExamSchedule_examId_locationId_key" ON "ExamSchedule"("examId", "locationId");
CREATE UNIQUE INDEX "ExamAttempt_examId_studentId_key" ON "ExamAttempt"("examId", "studentId");
CREATE INDEX "ExamAttempt_submittedAt_deadline_idx" ON "ExamAttempt"("submittedAt", "deadline");
ALTER TABLE "ExamQuestion" ADD CONSTRAINT "ExamQuestion_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExamSchedule" ADD CONSTRAINT "ExamSchedule_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExamSchedule" ADD CONSTRAINT "ExamSchedule_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExamAnswer" ADD CONSTRAINT "ExamAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamAnswer" ADD CONSTRAINT "ExamAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "ExamQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
