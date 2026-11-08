import { ForbiddenException } from '@nestjs/common';
import { authenticateAdmin } from './auth';
import { QuestionImportController } from './question-import.controller';
import { QuestionImportService } from './question-import.service';
import type { Request } from 'express';

jest.mock('./auth', () => ({ authenticateAdmin: jest.fn() }));
jest.mock('@prisma/client', () => ({
  PrismaClient: jest
    .fn()
    .mockImplementation(() => ({ $disconnect: jest.fn() })),
}));

describe('QuestionImportController', () => {
  const authenticate = jest.mocked(authenticateAdmin);
  const req = { headers: { origin: 'https://example.test' } } as Request;
  const service = new QuestionImportService();
  const controller = new QuestionImportController(service);
  beforeEach(() => authenticate.mockReset());

  it('authenticates exam creators with origin protection before parsing', async () => {
    authenticate.mockResolvedValue({
      id: 'admin',
      username: 'admin',
      role: 'exam_manager',
    });
    const result = await controller.preview(req, {
      csv: 'prompt,option1,option2,correctOption\nQ,A,B,2',
    });
    expect(result.valid).toBe(true);
    expect(authenticate).toHaveBeenCalledWith(
      expect.anything(),
      req,
      ['super_admin', 'exam_manager'],
      true,
    );
  });

  it('does not parse when authentication fails', async () => {
    authenticate.mockRejectedValue(new ForbiddenException());
    const spy = jest.spyOn(service, 'preview');
    await expect(controller.preview(req, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
