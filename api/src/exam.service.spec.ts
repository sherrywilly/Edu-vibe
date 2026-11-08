import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';
import type { Request } from 'express';
import { ExamService } from './exam.service';

const databaseUrl = process.env.EXAM_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

describe('deadline service clock', () => {
  it('uses the database clock after locking, and skips missing or submitted attempts', async () => {
    const service = new ExamService();
    const now = new Date('2026-01-01T00:00:00Z');
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'id' }])
        .mockResolvedValueOnce([{ now }]),
      examAttempt: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          submittedAt: null,
          deadline: new Date(now.getTime() + 2000),
        }),
      },
    };
    const finalize = jest.fn();
    Object.defineProperty(service, 'finalize', { value: finalize });
    Object.defineProperty(service, 'db', {
      value: { $transaction: (fn: (value: typeof tx) => unknown) => fn(tx) },
    });
    await expect(service.finalizeDue('id')).resolves.toEqual({
      remainingMs: 2000,
    });
    expect(finalize).not.toHaveBeenCalled();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'id' }])
      .mockResolvedValueOnce([{ now }]);
    tx.examAttempt.findUniqueOrThrow.mockResolvedValueOnce({
      submittedAt: null,
      deadline: now,
    });
    await expect(service.finalizeDue('id')).resolves.toBeNull();
    expect(finalize).toHaveBeenCalledWith(tx, 'id', now);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'id' }])
      .mockResolvedValueOnce([]);
    tx.examAttempt.findUniqueOrThrow.mockResolvedValueOnce({
      submittedAt: now,
    });
    await expect(service.finalizeDue('id')).resolves.toBeNull();
    await expect(service.finalizeDue('missing')).resolves.toBeNull();
    expect(finalize).toHaveBeenCalledTimes(1);
  });
});

integration('exam transactions (PostgreSQL)', () => {
  let db: PrismaClient;
  let service: ExamService;
  let locationId: string;
  let studentId: string;
  let examId: string;
  let questionId: string;
  const sessionId = randomBytes(32).toString('hex');

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.WEB_ORIGIN = 'https://school.example';
    db = new PrismaClient();
    service = new ExamService();
    locationId = randomUUID();
    studentId = randomUUID();
    await db.location.create({
      data: { id: locationId, name: 'Test', key: randomUUID().slice(0, 7) },
    });
    await db.student.create({
      data: {
        id: studentId,
        registrationId: randomUUID(),
        name: 'Test',
        dob: new Date('2000-01-01'),
        school: 'School',
        district: 'District',
        className: '1',
        medium: 'English',
        syllabus: 'Test',
        parentPhone: '1',
        whatsappPhone: '1',
        locality: 'Test',
        guardianConsentAt: new Date(),
        guardianConsentVersion: '1',
        locationId,
      },
    });
    await db.session.create({
      data: {
        id: createHash('sha256').update(sessionId).digest('hex'),
        role: 'student',
        studentId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const exam = await service.createExam(
      {
        title: 'Math',
        durationMinutes: 10,
        questions: [{ prompt: '2+2?', options: ['3', '4'], correctOption: 1 }],
      },
      'test-admin',
    );
    examId = exam.id;
    questionId = (await db.examQuestion.findFirstOrThrow({ where: { examId } }))
      .id;
    await service.schedule(
      examId,
      {
        locationId,
        opensAt: new Date(Date.now() - 60_000).toISOString(),
        closesAt: new Date(Date.now() + 60_000).toISOString(),
      },
      'test-admin',
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.examAnswer.deleteMany({ where: { attempt: { studentId } } });
    await db.examAttempt.deleteMany({ where: { studentId } });
    await db.examSchedule.deleteMany({ where: { examId } });
    await db.examQuestion.deleteMany({ where: { examId } });
    await db.exam.deleteMany({ where: { id: examId } });
    await db.auditLog.deleteMany({ where: { target: examId } });
    await db.session.deleteMany({ where: { studentId } });
    await db.student.deleteMany({ where: { id: studentId } });
    await db.location.deleteMany({ where: { id: locationId } });
    await service.onModuleDestroy();
    await db.$disconnect();
  });

  it('authenticates hashed session cookies and requires origin and role', async () => {
    const req = {
      headers: {
        cookie: `edu_session=${sessionId}`,
        origin: 'https://school.example',
      },
    } as Request;
    await expect(
      service.authenticate(req, 'student', true),
    ).resolves.toMatchObject({ studentId });
    await expect(service.authenticate(req, 'admin')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      service.authenticate(
        {
          headers: { ...req.headers, origin: 'https://evil.example' },
        } as Request,
        'student',
        true,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('validates creation and schedules and only lists assigned exams', async () => {
    await expect(
      service.createExam({
        title: 'Bad',
        durationMinutes: 5,
        questions: [
          { prompt: 'Question', options: ['A', 'B'], correctOption: 2 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.schedule(examId, {
        locationId,
        opensAt: '2026-01-02T00:00:00Z',
        closesAt: '2026-01-01T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const list = await service.listStudent(studentId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: examId,
      attempt: null,
      serverNow: expect.any(Date),
    });
    expect(JSON.stringify(await service.listAdmin())).not.toContain(
      'correctOption',
    );
    expect(
      await db.auditLog.count({
        where: {
          target: examId,
          actor: 'test-admin',
          action: { in: ['exam.created', 'exam.scheduled'] },
        },
      }),
    ).toBe(2);
    await expect(service.start(randomUUID(), studentId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects concurrent overlapping schedules and audits admin changes', async () => {
    const make = () =>
      service.createExam({
        title: 'Other',
        durationMinutes: 5,
        questions: [{ prompt: '?', options: ['A', 'B'], correctOption: 0 }],
      });
    const [one, two] = await Promise.all([make(), make()]);
    const ids = [one.id, two.id];
    try {
      const opensAt = new Date(Date.now() + 120_000).toISOString();
      const closesAt = new Date(Date.now() + 180_000).toISOString();
      const results = await Promise.allSettled(
        ids.map((id) =>
          service.schedule(id, { locationId, opensAt, closesAt }),
        ),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      expect(
        await db.auditLog.count({
          where: { target: { in: ids }, action: 'exam.scheduled' },
        }),
      ).toBe(1);
      expect(
        await db.auditLog.count({
          where: { target: { in: ids }, action: 'exam.created' },
        }),
      ).toBe(2);
    } finally {
      await db.examSchedule.deleteMany({ where: { examId: { in: ids } } });
      await db.examQuestion.deleteMany({ where: { examId: { in: ids } } });
      await db.exam.deleteMany({ where: { id: { in: ids } } });
      await db.auditLog.deleteMany({ where: { target: { in: ids } } });
    }
  });

  it('prevents a second active attempt after a location change', async () => {
    await service.start(examId, studentId);
    const otherLocationId = randomUUID();
    const other = await service.createExam({
      title: 'Other',
      durationMinutes: 5,
      questions: [{ prompt: '?', options: ['A', 'B'], correctOption: 0 }],
    });
    try {
      await db.location.create({
        data: {
          id: otherLocationId,
          name: 'Other',
          key: randomUUID().slice(0, 7),
        },
      });
      await service.schedule(other.id, {
        locationId: otherLocationId,
        opensAt: new Date(Date.now() - 60_000).toISOString(),
        closesAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await db.student.update({
        where: { id: studentId },
        data: { locationId: otherLocationId },
      });
      await expect(service.start(other.id, studentId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(
        await db.examAttempt.count({ where: { studentId, submittedAt: null } }),
      ).toBe(1);
    } finally {
      await db.student.update({
        where: { id: studentId },
        data: { locationId },
      });
      await db.examSchedule.deleteMany({ where: { examId: other.id } });
      await db.examQuestion.deleteMany({ where: { examId: other.id } });
      await db.exam.deleteMany({ where: { id: other.id } });
      await db.auditLog.deleteMany({ where: { target: other.id } });
      await db.location.deleteMany({ where: { id: otherLocationId } });
    }
  });

  it('serializes starts and revisions, hides keys, and scores only after publication', async () => {
    const [a, b] = await Promise.all([
      service.start(examId, studentId),
      service.start(examId, studentId),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.serverNow).toBeInstanceOf(Date);
    expect(a.deadline.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(JSON.stringify(a)).not.toContain('correctOption');
    await expect(service.getAttempt(a.id, randomUUID())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const writes = await Promise.allSettled([
      service.save(a.id, studentId, {
        revision: 0,
        answers: [{ questionId, option: 1 }],
      }),
      service.save(a.id, studentId, {
        revision: 0,
        answers: [{ questionId, option: 0 }],
      }),
    ]);
    expect(writes.filter((w) => w.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((w) => w.status === 'rejected')).toHaveLength(1);
    await expect(
      service.save(a.id, studentId, {
        revision: 1,
        answers: [{ questionId, option: 99 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const saved = await service.save(a.id, studentId, {
      revision: 1,
      answers: [{ questionId, option: 1 }],
    });
    expect(saved.revision).toBe(2);
    const submitted = await service.submit(a.id, studentId);
    expect(submitted.status).toBe('submitted');
    expect(submitted).not.toHaveProperty('score');
    expect((await service.submit(a.id, studentId)).id).toBe(a.id);
    await expect(
      service.save(a.id, studentId, { revision: 2, answers: [] }),
    ).rejects.toBeInstanceOf(ConflictException);
    await service.publish(examId, { published: true }, 'test-admin');
    expect(await service.getAttempt(a.id, studentId)).toMatchObject({
      score: 1,
      total: 1,
    });
    expect(
      await db.auditLog.count({
        where: {
          target: examId,
          action: 'exam.results.published',
          actor: 'test-admin',
        },
      }),
    ).toBe(1);
  });

  it('finalizes expired attempts even without a browser', async () => {
    await db.examAnswer.deleteMany({
      where: { attempt: { studentId, examId } },
    });
    await db.examAttempt.deleteMany({ where: { studentId, examId } });
    const attempt = await db.examAttempt.create({
      data: {
        studentId,
        examId,
        startedAt: new Date(Date.now() - 10000),
        deadline: new Date(Date.now() - 1000),
        answers: { create: { questionId, option: 1 } },
      },
    });
    await service.sweep();
    expect(
      await db.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).toMatchObject({ score: 1, submittedAt: expect.any(Date) });
  });

  it('only finalizes due jobs using the database clock and is idempotent', async () => {
    await db.examAnswer.deleteMany({
      where: { attempt: { studentId, examId } },
    });
    await db.examAttempt.deleteMany({ where: { studentId, examId } });
    const [{ now }] = await db.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS "now"`;
    const attempt = await db.examAttempt.create({
      data: {
        studentId,
        examId,
        startedAt: now,
        deadline: new Date(now.getTime() + 60_000),
      },
    });
    expect(await service.finalizeDue(attempt.id)).toMatchObject({
      remainingMs: expect.any(Number),
    });
    expect(
      (await db.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } }))
        .submittedAt,
    ).toBeNull();
    await db.examAttempt.update({
      where: { id: attempt.id },
      data: { deadline: new Date(now.getTime() - 1000) },
    });
    await Promise.all([
      service.finalizeDue(attempt.id),
      service.finalizeDue(attempt.id),
    ]);
    const finalized = await db.examAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(finalized).toMatchObject({
      submittedAt: expect.any(Date),
      score: 0,
    });
    await service.finalizeDue(attempt.id);
    expect(
      (await db.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } }))
        .submittedAt,
    ).toEqual(finalized.submittedAt);
    expect(await service.finalizeDue(randomUUID())).toBeNull();
  });

  it('persists deadline finalization even when rejecting a late save', async () => {
    await db.examAttempt.deleteMany({ where: { studentId, examId } });
    const attempt = await db.examAttempt.create({
      data: {
        studentId,
        examId,
        startedAt: new Date(Date.now() - 10000),
        deadline: new Date(Date.now() - 1000),
      },
    });
    await expect(
      service.save(attempt.id, studentId, { revision: 0, answers: [] }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      await db.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).toMatchObject({ score: 0, submittedAt: expect.any(Date) });
  });

  it('rolls back a write that crosses the deadline during the transaction', async () => {
    await db.examAttempt.deleteMany({ where: { studentId, examId } });
    const attempt = await db.examAttempt.create({
      data: {
        studentId,
        examId,
        startedAt: new Date(),
        deadline: new Date(Date.now() + 700),
      },
    });
    await db.$executeRawUnsafe(
      `CREATE FUNCTION exam_test_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER exam_test_delay BEFORE INSERT ON "ExamAnswer" FOR EACH ROW EXECUTE FUNCTION exam_test_delay()`,
    );
    try {
      await expect(
        service.save(attempt.id, studentId, {
          revision: 0,
          answers: [{ questionId, option: 1 }],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(
        await db.examAnswer.count({ where: { attemptId: attempt.id } }),
      ).toBe(0);
      expect(
        await db.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      ).toMatchObject({ score: 0, revision: 0, submittedAt: expect.any(Date) });
    } finally {
      await db.$executeRawUnsafe(
        `DROP TRIGGER exam_test_delay ON "ExamAnswer"`,
      );
      await db.$executeRawUnsafe(`DROP FUNCTION exam_test_delay()`);
    }
  });
});
