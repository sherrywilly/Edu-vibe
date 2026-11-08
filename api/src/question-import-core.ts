export type QuestionImportRow = {
  row: number;
  prompt: string;
  options: string[];
  correctOption: string;
};

export type QuestionImportPreview = {
  valid: boolean;
  rows: (QuestionImportRow & { errors: string[] })[];
};

export class QuestionImportError extends Error {}

function parseCsv(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [],
    field = '',
    quoted = false,
    closed = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === '"') {
      if (field || closed)
        throw new QuestionImportError('Malformed CSV quoting.');
      quoted = true;
    } else if (c === ',' || c === '\n' || c === '\r') {
      record.push(field);
      field = '';
      closed = false;
      if (c !== ',') {
        if (c === '\r' && csv[i + 1] === '\n') i++;
        records.push(record);
        record = [];
        if (records.length > 501)
          throw new QuestionImportError('CSV must contain 1–500 data rows.');
      }
    } else {
      if (closed) throw new QuestionImportError('Malformed CSV quoting.');
      field += c;
    }
  }
  if (quoted) throw new QuestionImportError('Unclosed CSV quote.');
  if (field || record.length || closed) {
    record.push(field);
    records.push(record);
  }
  return records;
}

export function previewCsv(csv: unknown): QuestionImportPreview {
  if (typeof csv !== 'string' || new TextEncoder().encode(csv).length > 32768)
    throw new QuestionImportError('Provide a CSV of at most 32 KiB.');
  const records = parseCsv(csv.replace(/^\uFEFF/, ''));
  const header = records[0]?.map((value) => value.trim());
  const optionCount = (header?.length ?? 0) - 2;
  if (
    !header ||
    optionCount < 2 ||
    optionCount > 10 ||
    header[0] !== 'prompt' ||
    header[header.length - 1] !== 'correctOption' ||
    Array.from({ length: optionCount }, (_, i) => `option${i + 1}`).some(
      (name, i) => header[i + 1] !== name,
    )
  ) {
    throw new QuestionImportError(
      'Header must be prompt,option1,option2,...,correctOption with 2–10 consecutively numbered options.',
    );
  }
  if (records.length < 2 || records.length > 501)
    throw new QuestionImportError('CSV must contain 1–500 data rows.');
  const rows = records.slice(1).map((cells, i) => {
    if (cells.length !== header.length)
      throw new QuestionImportError(
        `Record ${i + 2} has the wrong number of columns.`,
      );
    return {
      row: i + 2,
      prompt: cells[0],
      options: cells.slice(1, -1),
      correctOption: cells[cells.length - 1],
    };
  });
  return validateRows(rows);
}

export function validateRows(input: unknown): QuestionImportPreview {
  if (!Array.isArray(input) || input.length < 1 || input.length > 500)
    throw new QuestionImportError('Provide 1–500 question rows.');
  const seen = new Set<number>();
  const rows = input.map((value: unknown) => {
    if (!value || typeof value !== 'object')
      throw new QuestionImportError('Invalid question row.');
    const item = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(item.row) ||
      (item.row as number) < 2 ||
      seen.has(item.row as number) ||
      typeof item.prompt !== 'string' ||
      typeof item.correctOption !== 'string' ||
      !Array.isArray(item.options) ||
      item.options.length < 2 ||
      item.options.length > 10 ||
      item.options.some((option: unknown) => typeof option !== 'string')
    )
      throw new QuestionImportError('Invalid question row.');
    seen.add(item.row as number);
    const prompt = item.prompt;
    const options = item.options as string[];
    const correctOption = item.correctOption;
    const errors: string[] = [];
    if (!prompt.trim() || prompt.length > 5000)
      errors.push('Prompt is required and must be at most 5000 characters.');
    let last = options.length - 1;
    while (last >= 0 && !options[last].trim()) last--;
    if (last < 1) errors.push('At least two options are required.');
    options.forEach((option, index) => {
      if (index <= last && !option.trim())
        errors.push(`Option ${index + 1} cannot be blank between choices.`);
      if (option.length > 1000)
        errors.push(`Option ${index + 1} must be at most 1000 characters.`);
    });
    const answer = correctOption.trim();
    if (!/^(?:[1-9]|10)$/.test(answer) || Number(answer) > last + 1)
      errors.push(
        'Correct option must explicitly be a choice number from 1 to the last provided option.',
      );
    return { row: item.row as number, prompt, options, correctOption, errors };
  });
  return { valid: rows.every((row) => row.errors.length === 0), rows };
}
