import { createHmac, randomBytes } from 'crypto';

export type RandomizationQuestion = {
  id: string;
  prompt: string;
  options: unknown;
};

export type AttemptLayout = {
  version: 1;
  questions: { questionId: string; optionOrder: number[] }[];
};

export type AttemptAnswer = { questionId: string; option: number | null };

type ValidQuestion = { id: string; prompt: string; options: string[] };

function validateQuestions(
  questions: RandomizationQuestion[],
): Map<string, ValidQuestion> {
  if (!Array.isArray(questions)) throw new Error('Invalid questions.');
  const result = new Map<string, ValidQuestion>();
  for (const q of questions) {
    if (
      !q ||
      typeof q.id !== 'string' ||
      !q.id ||
      result.has(q.id) ||
      typeof q.prompt !== 'string' ||
      !Array.isArray(q.options) ||
      !q.options.length ||
      q.options.some((option: unknown) => typeof option !== 'string')
    )
      throw new Error('Invalid question.');
    result.set(q.id, {
      id: q.id,
      prompt: q.prompt,
      options: q.options as string[],
    });
  }
  return result;
}

function validateLayout(
  questions: RandomizationQuestion[],
  layout: unknown,
): { questions: Map<string, ValidQuestion>; layout: AttemptLayout } {
  const byId = validateQuestions(questions);
  if (!layout || typeof layout !== 'object')
    throw new Error('Invalid attempt layout.');
  const value = layout as AttemptLayout;
  if (
    value.version !== 1 ||
    !Array.isArray(value.questions) ||
    value.questions.length !== byId.size
  ) {
    throw new Error('Invalid attempt layout.');
  }
  const seen = new Set<string>();
  for (const entry of value.questions) {
    if (
      !entry ||
      typeof entry.questionId !== 'string' ||
      seen.has(entry.questionId)
    ) {
      throw new Error('Invalid attempt layout.');
    }
    const question = byId.get(entry.questionId);
    if (
      !question ||
      !Array.isArray(entry.optionOrder) ||
      entry.optionOrder.length !== question.options.length
    ) {
      throw new Error('Invalid attempt layout.');
    }
    const options = new Set<number>();
    for (const index of entry.optionOrder) {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= question.options.length ||
        options.has(index)
      ) {
        throw new Error('Invalid attempt layout.');
      }
      options.add(index);
    }
    seen.add(entry.questionId);
  }
  return { questions: byId, layout: value };
}

/**
 * Persist the returned layout, not the seed. A supplied 32-byte seed makes creation
 * reproducible; otherwise a cryptographically random seed is generated server-side.
 */
export function createAttemptLayout(
  questions: RandomizationQuestion[],
  settings: { shuffleQuestions?: boolean; shuffleOptions?: boolean } = {},
  seed: Buffer = randomBytes(32),
): AttemptLayout {
  const byId = validateQuestions(questions);
  if (
    !settings ||
    typeof settings !== 'object' ||
    (settings.shuffleQuestions !== undefined &&
      typeof settings.shuffleQuestions !== 'boolean') ||
    (settings.shuffleOptions !== undefined &&
      typeof settings.shuffleOptions !== 'boolean') ||
    !Buffer.isBuffer(seed) ||
    seed.length !== 32
  )
    throw new Error('Invalid randomization settings or seed.');

  let counter = 0;
  const next = (bound: number) => {
    const limit = Math.floor(0x100000000 / bound) * bound;
    for (;;) {
      const value = createHmac('sha256', seed)
        .update(`exam-layout-v1:${counter++}`)
        .digest()
        .readUInt32BE(0);
      if (value < limit) return value % bound;
    }
  };
  const shuffle = <T>(items: T[]) => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = next(i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
  };
  const entries = [...byId.values()].map((question) => {
    const optionOrder = question.options.map((_, index) => index);
    if (settings.shuffleOptions) shuffle(optionOrder);
    return { questionId: question.id, optionOrder };
  });
  if (settings.shuffleQuestions) shuffle(entries);
  return { version: 1, questions: entries };
}

/** Return only explicitly whitelisted student-visible fields. */
export function renderAttemptQuestions(
  questions: RandomizationQuestion[],
  layout: unknown,
) {
  const validated = validateLayout(questions, layout);
  return validated.layout.questions.map(({ questionId, optionOrder }) => {
    const question = validated.questions.get(questionId)!;
    return {
      id: question.id,
      prompt: question.prompt,
      options: optionOrder.map((index) => question.options[index]),
    };
  });
}

function mapAnswers(
  questions: RandomizationQuestion[],
  layout: unknown,
  answers: AttemptAnswer[],
  toCanonical: boolean,
): AttemptAnswer[] {
  const validated = validateLayout(questions, layout);
  if (!Array.isArray(answers)) throw new Error('Invalid answers.');
  const orders = new Map(
    validated.layout.questions.map((q) => [q.questionId, q.optionOrder]),
  );
  const seen = new Set<string>();
  return answers.map((answer) => {
    if (
      !answer ||
      typeof answer.questionId !== 'string' ||
      seen.has(answer.questionId)
    ) {
      throw new Error('Invalid answer.');
    }
    const order = orders.get(answer.questionId);
    if (!order) throw new Error('Invalid answer.');
    seen.add(answer.questionId);
    if (answer.option === null)
      return { questionId: answer.questionId, option: null };
    if (
      !Number.isInteger(answer.option) ||
      answer.option < 0 ||
      answer.option >= order.length
    ) {
      throw new Error('Invalid answer.');
    }
    return {
      questionId: answer.questionId,
      option: toCanonical ? order[answer.option] : order.indexOf(answer.option),
    };
  });
}

/** Convert displayed option indices to the canonical indices stored by ExamAnswer. */
export function answersToCanonical(
  questions: RandomizationQuestion[],
  layout: unknown,
  answers: AttemptAnswer[],
) {
  return mapAnswers(questions, layout, answers, true);
}

/** Convert stored canonical indices back to the displayed indices on every response. */
export function answersToDisplayed(
  questions: RandomizationQuestion[],
  layout: unknown,
  answers: AttemptAnswer[],
) {
  return mapAnswers(questions, layout, answers, false);
}
