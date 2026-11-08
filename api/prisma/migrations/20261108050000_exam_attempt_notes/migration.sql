CREATE TABLE "ExamReviewFlag" (
  "attemptId" TEXT NOT NULL,
  "questionId" TEXT NOT NULL,
  CONSTRAINT "ExamReviewFlag_pkey" PRIMARY KEY ("attemptId", "questionId"),
  CONSTRAINT "ExamReviewFlag_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ExamReviewFlag_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "ExamQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ExamFocusEvent" (
  "id" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExamFocusEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExamFocusEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ExamFocusEvent_attemptId_idx" ON "ExamFocusEvent"("attemptId");
