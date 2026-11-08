import { BadRequestException, Injectable } from '@nestjs/common';
import {
  previewCsv,
  QuestionImportError,
  validateRows,
} from './question-import-core';

@Injectable()
export class QuestionImportService {
  preview(body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Provide either csv or rows.');
    const input = body as Record<string, unknown>;
    if ('csv' in input === 'rows' in input)
      throw new BadRequestException('Provide either csv or rows.');
    try {
      return 'csv' in input ? previewCsv(input.csv) : validateRows(input.rows);
    } catch (error) {
      if (error instanceof QuestionImportError)
        throw new BadRequestException(error.message);
      throw error;
    }
  }
}
