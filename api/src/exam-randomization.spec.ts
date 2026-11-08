import {
  answersToCanonical,
  answersToDisplayed,
  createAttemptLayout,
  renderAttemptQuestions,
} from './exam-randomization';

const questions = [
  {
    id: 'q1',
    prompt: 'First',
    options: ['A', 'B', 'C'],
    correctOption: 1,
    secret: 'hidden',
  },
  { id: 'q2', prompt: 'Second', options: ['X', 'Y', 'Z'], correctOption: 0 },
  { id: 'q3', prompt: 'Third', options: ['D', 'E', 'F'], correctOption: 2 },
];
const seed = Buffer.alloc(32, 7);
const layout = {
  version: 1 as const,
  questions: [
    { questionId: 'q2', optionOrder: [2, 0, 1] },
    { questionId: 'q1', optionOrder: [1, 2, 0] },
    { questionId: 'q3', optionOrder: [0, 1, 2] },
  ],
};

describe('attempt randomization', () => {
  it('defaults to the original order and leaves inputs untouched', () => {
    const before = JSON.stringify(questions);
    const identity = createAttemptLayout(questions);
    expect(renderAttemptQuestions(questions, identity)).toEqual([
      { id: 'q1', prompt: 'First', options: ['A', 'B', 'C'] },
      { id: 'q2', prompt: 'Second', options: ['X', 'Y', 'Z'] },
      { id: 'q3', prompt: 'Third', options: ['D', 'E', 'F'] },
    ]);
    expect(JSON.stringify(questions)).toBe(before);
  });

  it('is reproducible with a seed and persists independently of later settings', () => {
    const settings = { shuffleQuestions: true, shuffleOptions: true };
    const created = createAttemptLayout(questions, settings, seed);
    expect(createAttemptLayout(questions, settings, seed)).toEqual(created);
    const persisted = JSON.parse(JSON.stringify(created)) as unknown;
    expect(renderAttemptQuestions(questions, persisted)).toEqual(
      renderAttemptQuestions(questions, created),
    );
    const sample = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify(
        createAttemptLayout(questions, settings, Buffer.alloc(32, i)),
      ),
    );
    expect(new Set(sample).size).toBeGreaterThan(1);
  });

  it('supports independent question and option flags', () => {
    const onlyQuestions = createAttemptLayout(
      questions,
      { shuffleQuestions: true },
      seed,
    );
    expect(
      onlyQuestions.questions.every((q) => q.optionOrder.join(',') === '0,1,2'),
    ).toBe(true);
    const onlyOptions = createAttemptLayout(
      questions,
      { shuffleOptions: true },
      seed,
    );
    expect(onlyOptions.questions.map((q) => q.questionId)).toEqual([
      'q1',
      'q2',
      'q3',
    ]);
    expect(
      onlyOptions.questions.some((q) => q.optionOrder.join(',') !== '0,1,2'),
    ).toBe(true);
  });

  it('whitelists rendered fields and converts answers in both directions', () => {
    expect(renderAttemptQuestions(questions, layout)).toEqual([
      { id: 'q2', prompt: 'Second', options: ['Z', 'X', 'Y'] },
      { id: 'q1', prompt: 'First', options: ['B', 'C', 'A'] },
      { id: 'q3', prompt: 'Third', options: ['D', 'E', 'F'] },
    ]);
    const displayed = [
      { questionId: 'q1', option: 0 },
      { questionId: 'q2', option: 2 },
      { questionId: 'q3', option: null },
    ];
    const canonical = answersToCanonical(questions, layout, displayed);
    expect(canonical).toEqual([
      { questionId: 'q1', option: 1 },
      { questionId: 'q2', option: 1 },
      { questionId: 'q3', option: null },
    ]);
    expect(answersToDisplayed(questions, layout, canonical)).toEqual(displayed);
    expect(answersToCanonical(questions, layout, [])).toEqual([]);
  });

  it('round-trips every option of every question', () => {
    for (const q of questions) {
      q.options.forEach((_, option) => {
        const answer = [{ questionId: q.id, option }];
        expect(
          answersToDisplayed(
            questions,
            layout,
            answersToCanonical(questions, layout, answer),
          ),
        ).toEqual(answer);
      });
    }
  });

  it('rejects invalid questions, settings, and seeds', () => {
    expect(() => createAttemptLayout([questions[0], questions[0]])).toThrow();
    expect(() =>
      createAttemptLayout([{ id: 'x', prompt: '', options: ['a', 1] }]),
    ).toThrow();
    expect(() =>
      createAttemptLayout(questions, { shuffleOptions: 'yes' } as never),
    ).toThrow();
    expect(() => createAttemptLayout(questions, {}, Buffer.alloc(1))).toThrow();
  });

  it('rejects corrupt, incomplete, duplicate, or stale persisted layouts', () => {
    const badLayouts: unknown[] = [
      null,
      {},
      { ...layout, version: 2 },
      { ...layout, questions: layout.questions.slice(1) },
      {
        ...layout,
        questions: [
          layout.questions[0],
          layout.questions[0],
          layout.questions[2],
        ],
      },
      {
        ...layout,
        questions: [
          { questionId: 'missing', optionOrder: [0, 1, 2] },
          ...layout.questions.slice(1),
        ],
      },
      {
        ...layout,
        questions: [
          { questionId: 'q2', optionOrder: [0, 0, 2] },
          ...layout.questions.slice(1),
        ],
      },
      {
        ...layout,
        questions: [
          { questionId: 'q2', optionOrder: [0, 1, 3] },
          ...layout.questions.slice(1),
        ],
      },
      {
        ...layout,
        questions: [
          { questionId: 'q2', optionOrder: [0, 1] },
          ...layout.questions.slice(1),
        ],
      },
    ];
    for (const bad of badLayouts) {
      expect(() => renderAttemptQuestions(questions, bad)).toThrow();
      expect(() => answersToCanonical(questions, bad, [])).toThrow();
    }
  });

  it('rejects unknown, duplicate, and invalid answers in both directions', () => {
    const invalid = [
      [{ questionId: 'unknown', option: 0 }],
      [
        { questionId: 'q1', option: 0 },
        { questionId: 'q1', option: 1 },
      ],
      [{ questionId: 'q1', option: -1 }],
      [{ questionId: 'q1', option: 3 }],
      [{ questionId: 'q1', option: 0.5 }],
      [{ questionId: 'q1', option: '0' }],
    ];
    for (const answers of invalid) {
      expect(() =>
        answersToCanonical(questions, layout, answers as never),
      ).toThrow();
      expect(() =>
        answersToDisplayed(questions, layout, answers as never),
      ).toThrow();
    }
  });
});
