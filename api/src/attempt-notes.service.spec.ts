import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AttemptNotesService } from './attempt-notes.service';
import { AttemptNotesController } from './attempt-notes.controller';
import type { ExamService } from './exam.service';
import type { Request } from 'express';

describe('attempt notes', () => {
  let service: AttemptNotesService;
  let tx: {
    $queryRaw: jest.Mock;
    examQuestion: { findFirst: jest.Mock };
  };
  beforeEach(() => {
    service = new AttemptNotesService();
    tx = {
      $queryRaw: jest.fn(),
      examQuestion: { findFirst: jest.fn().mockResolvedValue({ id: 'q' }) },
    };
    Object.defineProperty(service, 'db', {
      value: { $transaction: (fn: (value: typeof tx) => unknown) => fn(tx) },
      configurable: true,
    });
  });

  it('only reads flags after locking an owned attempt', async () => {
    tx.$queryRaw.mockResolvedValueOnce([]); // missing or another student's attempt
    await expect(service.get('a', 'other')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'a', examId: 'exam' }])
      .mockResolvedValueOnce([{ questionId: 'q' }]);
    await expect(service.get('a', 'owner')).resolves.toEqual({
      flaggedQuestionIds: ['q'],
    });
    expect((tx.$queryRaw.mock.calls[1] as unknown[]).slice(1)).toEqual([
      'a',
      'owner',
    ]);
  });

  it('validates input and question membership, and saves explicit flag states', async () => {
    await expect(
      service.setFlag('a', 's', 'q', { flagged: 'yes' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    tx.$queryRaw.mockResolvedValueOnce([{ id: 'a', examId: 'exam' }]);
    tx.examQuestion.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.setFlag('a', 's', 'other', { flagged: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.examQuestion.findFirst).toHaveBeenCalledWith({
      where: { id: 'other', examId: 'exam' },
      select: { id: true },
    });
    for (const flagged of [true, false]) {
      tx.$queryRaw
        .mockResolvedValueOnce([{ id: 'a', examId: 'exam' }])
        .mockResolvedValueOnce([{ id: 'a' }]);
      await expect(
        service.setFlag('a', 's', 'q', { flagged }),
      ).resolves.toEqual({ questionId: 'q', flagged });
    }
  });

  it('rejects closed flag writes and closed or excess events', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'a', examId: 'exam' }])
      .mockResolvedValueOnce([]);
    await expect(
      service.setFlag('a', 's', 'q', { flagged: false }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.recordEvent('a', 's', { type: 'arbitrary text' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'a', examId: 'exam' }])
      .mockResolvedValueOnce([]);
    await expect(
      service.recordEvent('a', 's', { type: 'blur' }),
    ).rejects.toBeInstanceOf(ConflictException);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'a', examId: 'exam' }])
      .mockResolvedValueOnce([{ id: 'event' }]);
    await expect(
      service.recordEvent('a', 's', { type: 'focus' }),
    ).resolves.toEqual({ recorded: true });
  });

  it('requires student authentication and mutation origin checking on both writes', async () => {
    const authenticate = jest.fn().mockResolvedValue({ studentId: 's' });
    const notes = {
      get: jest.fn(),
      setFlag: jest.fn(),
      recordEvent: jest.fn(),
    };
    const controller = new AttemptNotesController(
      { authenticate } as unknown as ExamService,
      notes as unknown as AttemptNotesService,
    );
    const req = {} as Request;
    await controller.get(req, 'a');
    await controller.flag(req, 'a', 'q', { flagged: true });
    await controller.event(req, 'a', { type: 'blur' });
    expect(authenticate.mock.calls).toEqual([
      [req, 'student'],
      [req, 'student', true],
      [req, 'student', true],
    ]);
  });

  it('only serves summaries to authorized admin roles', async () => {
    const authenticateAdmin = jest.fn().mockResolvedValue({});
    const eventSummary = jest.fn().mockResolvedValue({ total: 0, counts: [] });
    const controller = new AttemptNotesController(
      {} as ExamService,
      { authenticateAdmin, eventSummary } as unknown as AttemptNotesService,
    );
    const req = {} as Request;
    await controller.summary(req, 'attempt');
    expect(authenticateAdmin).toHaveBeenCalledWith(req);
    expect(eventSummary).toHaveBeenCalledWith('attempt');
    authenticateAdmin.mockRejectedValueOnce(new UnauthorizedException());
    await expect(controller.summary(req, 'attempt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(eventSummary).toHaveBeenCalledTimes(1);
  });

  it('accepts only current admin accounts with an allowed role', async () => {
    const session = jest.fn().mockResolvedValue({
      role: 'admin',
      adminId: 'admin',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const admin = jest.fn();
    Object.defineProperty(service, 'db', {
      value: {
        session: { findUnique: session },
        adminAccount: { findUnique: admin },
      },
      configurable: true,
    });
    const req = {
      headers: { cookie: `edu_session=${'a'.repeat(64)}` },
    } as Request;
    for (const role of ['super_admin', 'exam_manager', 'reviewer']) {
      admin.mockResolvedValueOnce({ id: 'admin', username: 'admin', role });
      await expect(service.authenticateAdmin(req)).resolves.toMatchObject({
        role,
      });
    }
    admin.mockResolvedValueOnce({
      id: 'admin',
      username: 'admin',
      role: 'student',
    });
    await expect(service.authenticateAdmin(req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    session.mockResolvedValueOnce({
      role: 'student',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(service.authenticateAdmin(req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
