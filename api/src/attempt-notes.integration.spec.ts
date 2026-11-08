import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AttemptNotesService } from './attempt-notes.service';
import { ExamService } from './exam.service';

const databaseUrl = process.env.EXAM_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('attempt notes (PostgreSQL)', () => {
  let db: PrismaClient;
  let notes: AttemptNotesService;
  let exams: ExamService;
  const locationId = randomUUID(),
    studentId = randomUUID(),
    examId = randomUUID();
  const attemptId = randomUUID(),
    questionId = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    db = new PrismaClient();
    notes = new AttemptNotesService();
    exams = new ExamService();
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
    await db.exam.create({
      data: { id: examId, title: 'Test', durationMinutes: 10 },
    });
    await db.examQuestion.create({
      data: {
        id: questionId,
        examId,
        position: 0,
        prompt: 'Question',
        options: ['A', 'B'],
        correctOption: 0,
      },
    });
    await db.examAttempt.create({
      data: {
        id: attemptId,
        examId,
        studentId,
        startedAt: new Date(),
        deadline: new Date(Date.now() + 300_000),
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.examAttempt.deleteMany({ where: { id: attemptId } });
    await db.examQuestion.deleteMany({ where: { examId } });
    await db.exam.deleteMany({ where: { id: examId } });
    await db.student.deleteMany({ where: { id: studentId } });
    await db.location.deleteMany({ where: { id: locationId } });
    await notes.onModuleDestroy();
    await exams.onModuleDestroy();
    await db.$disconnect();
  });

  it('persists flags, enforces ownership and question membership, and caps informational events', async () => {
    await expect(notes.get(attemptId, randomUUID())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      notes.setFlag(attemptId, studentId, randomUUID(), { flagged: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await notes.setFlag(attemptId, studentId, questionId, { flagged: true });
    await expect(notes.get(attemptId, studentId)).resolves.toEqual({
      flaggedQuestionIds: [questionId],
    });
    await notes.setFlag(attemptId, studentId, questionId, { flagged: false });
    await expect(notes.get(attemptId, studentId)).resolves.toEqual({
      flaggedQuestionIds: [],
    });
    await notes.setFlag(attemptId, studentId, questionId, { flagged: true });
    for (let i = 0; i < 98; i++)
      await notes.recordEvent(attemptId, studentId, { type: 'blur' });
    await Promise.all(
      Array.from({ length: 5 }, () =>
        notes
          .recordEvent(attemptId, studentId, { type: 'blur' })
          .catch((error) => {
            if (!(error instanceof ConflictException)) throw error;
          }),
      ),
    );
    const [{ count }] = await db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM "ExamFocusEvent" WHERE "attemptId" = ${attemptId}`;
    expect(count).toBe(100n);
    await expect(notes.eventSummary(attemptId)).resolves.toEqual({
      attemptId,
      total: 100,
      counts: [{ type: 'blur', count: 100 }],
    });
    const before = await db.examAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    expect(before.submittedAt).toBeNull();
    expect(before.score).toBeNull();
    await db.examAttempt.update({
      where: { id: attemptId },
      data: { deadline: new Date(Date.now() - 1000) },
    });
    await expect(
      notes.setFlag(attemptId, studentId, questionId, { flagged: false }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      notes.recordEvent(attemptId, studentId, { type: 'focus' }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(notes.get(attemptId, studentId)).resolves.toEqual({
      flaggedQuestionIds: [questionId],
    });
    await exams.submit(attemptId, studentId);
    await expect(
      notes.setFlag(attemptId, studentId, questionId, { flagged: true }),
    ).rejects.toBeInstanceOf(ConflictException);
  }, 30000);
});
