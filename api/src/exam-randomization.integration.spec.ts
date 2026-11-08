import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ExamService } from './exam.service';

const databaseUrl = process.env.EXAM_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('attempt randomization (PostgreSQL)', () => {
  let db: PrismaClient;
  let service: ExamService;
  const exams: string[] = [];
  const locations: string[] = [];
  const students: string[] = [];

  beforeAll(() => {
    process.env.DATABASE_URL = databaseUrl;
    db = new PrismaClient();
    service = new ExamService();
  });

  afterAll(async () => {
    await db.examAnswer.deleteMany({
      where: { attempt: { examId: { in: exams } } },
    });
    await db.examAttempt.deleteMany({ where: { examId: { in: exams } } });
    await db.examSchedule.deleteMany({ where: { examId: { in: exams } } });
    await db.examQuestion.deleteMany({ where: { examId: { in: exams } } });
    await db.exam.deleteMany({ where: { id: { in: exams } } });
    await db.auditLog.deleteMany({ where: { target: { in: exams } } });
    await db.student.deleteMany({ where: { id: { in: students } } });
    await db.location.deleteMany({ where: { id: { in: locations } } });
    await service.onModuleDestroy();
    await db.$disconnect();
  });

  async function fixture(shuffleQuestions: boolean, shuffleOptions: boolean) {
    const locationId = randomUUID(),
      studentId = randomUUID();
    locations.push(locationId);
    students.push(studentId);
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
    const exam = await service.createExam({
      title: 'Randomization',
      durationMinutes: 10,
      shuffleQuestions,
      shuffleOptions,
      questions: [
        {
          prompt: 'First',
          options: ['A', 'B', 'C'],
          correctOption: 1,
          subject: 'Math',
          marks: 3,
        },
        {
          prompt: 'Second',
          options: ['D', 'E', 'F'],
          correctOption: 2,
          subject: 'Math',
          marks: 2,
        },
      ],
    });
    exams.push(exam.id);
    await service.schedule(exam.id, {
      locationId,
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const questions = await db.examQuestion.findMany({
      where: { examId: exam.id },
      orderBy: { position: 'asc' },
    });
    return { exam, studentId, questions };
  }

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'persists and resumes layout for flags %s, %s',
    async (shuffleQuestions, shuffleOptions) => {
      const { exam, studentId, questions } = await fixture(
        shuffleQuestions,
        shuffleOptions,
      );
      const [first, repeated] = await Promise.all([
        service.start(exam.id, studentId),
        service.start(exam.id, studentId),
      ]);
      expect(repeated.id).toBe(first.id);
      expect(repeated.questions).toEqual(first.questions);
      const stored = await db.examAttempt.findUniqueOrThrow({
        where: { id: first.id },
      });
      expect(stored.randomizationLayout).not.toBeNull();
      expect((await service.getAttempt(first.id, studentId)).questions).toEqual(
        first.questions,
      );
      expect(JSON.stringify(first)).not.toMatch(
        /correctOption|randomizationLayout|optionOrder/,
      );
      expect(first.questions[0]).toHaveProperty('subject', 'Math');
      if (!shuffleQuestions)
        expect(first.questions.map((q) => q.id)).toEqual(
          questions.map((q) => q.id),
        );
      if (!shuffleOptions) {
        for (const q of first.questions) {
          expect(q.options).toEqual(
            questions.find((original) => original.id === q.id)?.options,
          );
        }
      }
    },
  );

  it('maps saved answers to canonical indices, renders back, and scores canonically', async () => {
    const { exam, studentId, questions } = await fixture(true, true);
    const attempt = await service.start(exam.id, studentId);
    await db.examAttempt.update({
      where: { id: attempt.id },
      data: {
        randomizationLayout: {
          version: 1,
          questions: [
            { questionId: questions[1].id, optionOrder: [2, 0, 1] },
            { questionId: questions[0].id, optionOrder: [1, 2, 0] },
          ],
        },
      },
    });
    const answers = [
      { questionId: questions[0].id, option: 0 },
      { questionId: questions[1].id, option: 0 },
    ];
    const saved = await service.save(attempt.id, studentId, {
      revision: 0,
      answers,
    });
    expect(saved.answers).toEqual(expect.arrayContaining(answers));
    const stored = await db.examAnswer.findMany({
      where: { attemptId: attempt.id },
    });
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ questionId: questions[0].id, option: 1 }),
        expect.objectContaining({ questionId: questions[1].id, option: 2 }),
      ]),
    );
    expect((await service.getAttempt(attempt.id, studentId)).answers).toEqual(
      expect.arrayContaining(answers),
    );
    await expect(
      service.save(attempt.id, studentId, { revision: 0, answers }),
    ).rejects.toBeInstanceOf(ConflictException);
    for (const invalid of [
      [{ questionId: questions[0].id, option: 3 }],
      [{ questionId: randomUUID(), option: 0 }],
      [answers[0], answers[0]],
    ])
      await expect(
        service.save(attempt.id, studentId, { revision: 1, answers: invalid }),
      ).rejects.toBeInstanceOf(BadRequestException);
    const cleared = await service.save(attempt.id, studentId, {
      revision: 1,
      answers: [{ questionId: questions[0].id, option: null }, answers[1]],
    });
    expect(cleared.answers).toEqual([answers[1]]);
    expect(
      await db.examAnswer.count({ where: { attemptId: attempt.id } }),
    ).toBe(1);
    await service.save(attempt.id, studentId, { revision: 2, answers });
    await service.publish(exam.id, { published: true });
    const submitted = await service.submit(attempt.id, studentId);
    expect(submitted.score).toBe(5);
    expect(submitted.answers).toEqual(expect.arrayContaining(answers));
    expect(JSON.stringify(submitted)).not.toMatch(
      /correctOption|randomizationLayout|optionOrder/,
    );
  });

  it('uses canonical answers at deadline for randomized attempts', async () => {
    const { exam, studentId, questions } = await fixture(false, true);
    const attempt = await service.start(exam.id, studentId);
    await db.examAttempt.update({
      where: { id: attempt.id },
      data: {
        randomizationLayout: {
          version: 1,
          questions: [
            { questionId: questions[0].id, optionOrder: [1, 2, 0] },
            { questionId: questions[1].id, optionOrder: [2, 0, 1] },
          ],
        },
      },
    });
    await service.save(attempt.id, studentId, {
      revision: 0,
      answers: [
        { questionId: questions[0].id, option: 0 },
        { questionId: questions[1].id, option: 0 },
      ],
    });
    await db.examAttempt.update({
      where: { id: attempt.id },
      data: { deadline: new Date(Date.now() - 1000) },
    });
    await service.finalizeDue(attempt.id);
    expect(
      (await db.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } }))
        .score,
    ).toBe(5);
  });

  it('rejects non-boolean settings', async () => {
    await expect(
      service.createExam({
        title: 'Bad',
        durationMinutes: 5,
        shuffleOptions: 'true',
        questions: [{ prompt: '?', options: ['A', 'B'], correctOption: 0 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('preserves legacy null-layout answers and deadline scoring', async () => {
    const { exam, studentId, questions } = await fixture(true, true);
    const legacy = await db.examAttempt.create({
      data: {
        examId: exam.id,
        studentId,
        startedAt: new Date(),
        deadline: new Date(Date.now() + 60_000),
        answers: { create: [{ questionId: questions[0].id, option: 1 }] },
      },
    });
    const rendered = await service.start(exam.id, studentId);
    expect(rendered.questions.map((q) => q.id)).toEqual(
      questions.map((q) => q.id),
    );
    expect(rendered.answers).toEqual([
      { questionId: questions[0].id, option: 1 },
    ]);
    await db.examAttempt.update({
      where: { id: legacy.id },
      data: { deadline: new Date(Date.now() - 1000) },
    });
    await service.finalizeDue(legacy.id);
    expect(
      (await db.examAttempt.findUniqueOrThrow({ where: { id: legacy.id } }))
        .score,
    ).toBe(3);
  });

  it('fails closed for malformed stored layouts', async () => {
    const { exam, studentId } = await fixture(true, true);
    const attempt = await service.start(exam.id, studentId);
    await db.examAttempt.update({
      where: { id: attempt.id },
      data: {
        randomizationLayout: { version: 1, questions: [] },
      },
    });
    await expect(service.getAttempt(attempt.id, studentId)).rejects.toThrow(
      'Invalid attempt layout.',
    );
    await expect(
      service.save(attempt.id, studentId, { revision: 0, answers: [] }),
    ).rejects.toThrow('Invalid attempt layout.');
  });
});
