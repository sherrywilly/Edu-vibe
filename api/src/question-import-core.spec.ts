import { previewCsv, validateRows } from './question-import-core';

describe('question import parsing and validation', () => {
  it('parses quoted CSV, BOM, CRLF and explicit answers without guessing', () => {
    const preview = previewCsv(
      '\ufeffprompt,option1,option2,option3,correctOption\r\n"Line 1\nLine ""2""","a,b",B,,2\r\n',
    );
    expect(preview.valid).toBe(true);
    expect(preview.rows[0]).toEqual({
      row: 2,
      prompt: 'Line 1\nLine "2"',
      options: ['a,b', 'B', ''],
      correctOption: '2',
      errors: [],
    });
    for (const answer of ['', '0', '3', 'A', '1.0', '01', '-1']) {
      expect(
        previewCsv(`prompt,option1,option2,correctOption\nQ,A,B,${answer}`)
          .valid,
      ).toBe(false);
    }
  });

  it('flags errors and validates corrected rows', () => {
    const preview = previewCsv(
      'prompt,option1,option2,option3,correctOption\n,first,,third,',
    );
    expect(preview.valid).toBe(false);
    expect(preview.rows[0].errors).toHaveLength(3);
    const row = {
      ...preview.rows[0],
      prompt: 'Question',
      options: ['first', 'second', 'third'],
      correctOption: '3',
    };
    expect(validateRows([row]).valid).toBe(true);
    expect(validateRows([{ ...row, correctOption: '' }]).valid).toBe(false);
    expect(validateRows([{ ...row, options: ['first', '', ''] }]).valid).toBe(
      false,
    );
    expect(validateRows([{ ...row, prompt: 'a'.repeat(5001) }]).valid).toBe(
      false,
    );
    expect(
      validateRows([{ ...row, options: ['a'.repeat(1001), 'b'] }]).valid,
    ).toBe(false);
  });

  it('rejects malformed structure and enforces limits', () => {
    for (const csv of [
      '',
      'prompt,option1,option3,correctOption\nQ,A,B,1',
      'prompt,option1,option2,correctOption\n"Q,A,B,1',
      'prompt,option1,option2,correctOption\nQ,A,B,1,extra',
      'prompt,option1,option2,correctOption\n"Q"x,A,B,1',
      'x'.repeat(32769),
      `prompt,option1,option2,correctOption\n${'Q,A,B,1\n'.repeat(501)}`,
    ])
      expect(() => previewCsv(csv)).toThrow();
    expect(() => validateRows([])).toThrow();
    expect(() =>
      validateRows([
        { row: 2, prompt: 'Q', options: ['a', 1], correctOption: '1' },
      ]),
    ).toThrow();
    const row = {
      row: 2,
      prompt: 'Q',
      options: ['a', 'b'],
      correctOption: '1',
    };
    expect(() => validateRows([row, row])).toThrow();
  });

  it('accepts 500 questions and 10 options', () => {
    const headers = [
      'prompt',
      ...Array.from({ length: 10 }, (_, i) => `option${i + 1}`),
      'correctOption',
    ];
    const line = [
      'Q',
      ...Array.from({ length: 10 }, (_, i) => `A${i}`),
      '10',
    ].join(',');
    const result = previewCsv(
      `${headers.join(',')}\n${Array(500).fill(line).join('\n')}`,
    );
    expect(result.valid).toBe(true);
    expect(result.rows).toHaveLength(500);
  });
});
