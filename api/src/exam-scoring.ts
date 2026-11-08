const MAX_INT = 2_147_483_647;

export type ScoringQuestion = {
  id: string;
  subject: string;
  marks: number;
  negativeMarks: number;
  correctOption: number;
};

export type ScoringAnswer = { questionId: string; option: number | null };
export type ScoringFields = {
  subject: string;
  marks: number;
  negativeMarks: number;
};

function integer(value: unknown, min: number, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > MAX_INT
  ) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

/**
 * Legacy requests omit these fields; defaults preserve one mark per question.
 */
export function validateScoringFields(input: {
  subject?: unknown;
  marks?: unknown;
  negativeMarks?: unknown;
}): ScoringFields {
  const subject = input.subject === undefined ? 'General' : input.subject;
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 200) {
    throw new Error('Invalid subject.');
  }
  return {
    subject: subject.trim(),
    marks: integer(input.marks === undefined ? 1 : input.marks, 1, 'marks'),
    negativeMarks: integer(
      input.negativeMarks === undefined ? 0 : input.negativeMarks,
      0,
      'negative marks',
    ),
  };
}

export function validatePassingScore(
  value: unknown,
  totalMarks: number,
): number | null {
  integer(totalMarks, 0, 'total marks');
  if (value === undefined || value === null) return null;
  const passingScore = integer(value, 0, 'passing score');
  if (passingScore > totalMarks)
    throw new Error('Passing score exceeds total marks.');
  return passingScore;
}

export function scoreExam(
  questions: ScoringQuestion[],
  answers: ScoringAnswer[],
  passingScore?: number | null,
) {
  const byId = new Map<string, ScoringQuestion>();
  let totalMarks = 0;
  let totalNegativeMarks = 0;
  for (const q of questions) {
    if (typeof q.id !== 'string' || !q.id || byId.has(q.id))
      throw new Error('Invalid question id.');
    const fields = validateScoringFields(q);
    integer(q.correctOption, 0, 'correct option');
    byId.set(q.id, { ...q, ...fields });
    totalMarks += fields.marks;
    totalNegativeMarks += fields.negativeMarks;
    if (totalMarks > MAX_INT || totalNegativeMarks > MAX_INT) {
      throw new Error('Exam marks exceed the supported range.');
    }
  }
  const threshold = validatePassingScore(passingScore, totalMarks);
  const selected = new Map<string, number | null>();
  for (const answer of answers) {
    if (!byId.has(answer.questionId) || selected.has(answer.questionId)) {
      throw new Error('Invalid answer question id.');
    }
    if (answer.option !== null) integer(answer.option, 0, 'answer option');
    selected.set(answer.questionId, answer.option);
  }
  const subjects = new Map<
    string,
    {
      subject: string;
      score: number;
      total: number;
      correct: number;
      incorrect: number;
      unanswered: number;
    }
  >();
  let score = 0,
    correct = 0,
    incorrect = 0,
    unanswered = 0;
  for (const q of byId.values()) {
    const subject = subjects.get(q.subject) ?? {
      subject: q.subject,
      score: 0,
      total: 0,
      correct: 0,
      incorrect: 0,
      unanswered: 0,
    };
    subject.total += q.marks;
    const option = selected.get(q.id);
    if (option === undefined || option === null) {
      unanswered++;
      subject.unanswered++;
    } else if (option === q.correctOption) {
      score += q.marks;
      subject.score += q.marks;
      correct++;
      subject.correct++;
    } else {
      score -= q.negativeMarks;
      subject.score -= q.negativeMarks;
      incorrect++;
      subject.incorrect++;
    }
    subjects.set(q.subject, subject);
  }
  return {
    score,
    total: totalMarks,
    correct,
    incorrect,
    unanswered,
    passingScore: threshold,
    passed: threshold === null ? null : score >= threshold,
    subjects: [...subjects.values()],
  };
}
