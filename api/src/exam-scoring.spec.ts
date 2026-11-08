import {
  scoreExam,
  validatePassingScore,
  validateScoringFields,
} from './exam-scoring';

describe('exam scoring', () => {
  it('normalizes legacy defaults and validates the authoring fields', () => {
    expect(validateScoringFields({})).toEqual({
      subject: 'General',
      marks: 1,
      negativeMarks: 0,
    });
    expect(
      validateScoringFields({ subject: ' Math ', marks: 3, negativeMarks: 1 }),
    ).toEqual({ subject: 'Math', marks: 3, negativeMarks: 1 });
    for (const input of [
      { subject: '' },
      { subject: 2 },
      { subject: 'x'.repeat(201) },
      { marks: 0 },
      { marks: 1.5 },
      { marks: '1' },
      { marks: 2147483648 },
      { negativeMarks: -1 },
      { negativeMarks: 0.1 },
      { negativeMarks: null },
    ])
      expect(() => validateScoringFields(input)).toThrow();
    expect(validatePassingScore(undefined, 4)).toBeNull();
    expect(validatePassingScore(0, 4)).toBe(0);
    for (const value of [-1, 5, 1.5, '2']) {
      expect(() => validatePassingScore(value, 4)).toThrow();
    }
  });

  it('scores correct, wrong and unanswered questions by subject without exposing answers', () => {
    const questions = [
      {
        id: 'a',
        subject: 'Math',
        marks: 4,
        negativeMarks: 1,
        correctOption: 0,
      },
      {
        id: 'b',
        subject: 'Math',
        marks: 2,
        negativeMarks: 3,
        correctOption: 1,
      },
      {
        id: 'c',
        subject: 'Science',
        marks: 1,
        negativeMarks: 0,
        correctOption: 0,
      },
      {
        id: 'd',
        subject: 'Science',
        marks: 1,
        negativeMarks: 0,
        correctOption: 0,
      },
    ];
    const result = scoreExam(
      questions,
      [
        { questionId: 'a', option: 0 },
        { questionId: 'b', option: 0 },
        { questionId: 'c', option: null },
      ],
      1,
    );
    expect(result).toEqual({
      score: 1,
      total: 8,
      correct: 1,
      incorrect: 1,
      unanswered: 2,
      passingScore: 1,
      passed: true,
      subjects: [
        {
          subject: 'Math',
          score: 1,
          total: 6,
          correct: 1,
          incorrect: 1,
          unanswered: 0,
        },
        {
          subject: 'Science',
          score: 0,
          total: 2,
          correct: 0,
          incorrect: 0,
          unanswered: 2,
        },
      ],
    });
    expect(
      scoreExam(questions, [{ questionId: 'b', option: 0 }], 0).passed,
    ).toBe(false);
    expect(scoreExam(questions, []).passed).toBeNull();
  });

  it('rejects duplicate or unknown answers and out-of-range totals', () => {
    const q = {
      id: 'a',
      subject: 'Math',
      marks: 1,
      negativeMarks: 0,
      correctOption: 0,
    };
    expect(() => scoreExam([q, q], [])).toThrow();
    expect(() => scoreExam([q], [{ questionId: 'x', option: 0 }])).toThrow();
    expect(() =>
      scoreExam(
        [q],
        [
          { questionId: 'a', option: 0 },
          { questionId: 'a', option: 1 },
        ],
      ),
    ).toThrow();
    expect(() => scoreExam([q], [{ questionId: 'a', option: -1 }])).toThrow();
    expect(() =>
      scoreExam(
        [
          { ...q, marks: 2147483647 },
          { ...q, id: 'b' },
        ],
        [],
      ),
    ).toThrow();
    expect(() =>
      scoreExam(
        [
          { ...q, negativeMarks: 2147483647 },
          { ...q, id: 'b', negativeMarks: 1 },
        ],
        [],
      ),
    ).toThrow();
  });
});
