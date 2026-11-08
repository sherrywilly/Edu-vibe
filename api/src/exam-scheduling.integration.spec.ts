import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ExamService } from './exam.service';

const databaseUrl = process.env.EXAM_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('exam scheduling (PostgreSQL)', () => {
  let db: PrismaClient;
  let service: ExamService;
  let locations: string[];
  let students: string[];
  const exams: string[] = [];

  const window = () => ({
    opensAt: new Date(Date.now() - 60_000).toISOString(),
    closesAt: new Date(Date.now() + 600_000).toISOString(),
  });
  const makeExam = async () => {
    const exam = await service.createExam({
      title: 'Scheduling test',
      durationMinutes: 10,
      questions: [{ prompt: '?', options: ['A', 'B'], correctOption: 0 }],
    });
    exams.push(exam.id);
    return exam.id;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    db = new PrismaClient();
    service = new ExamService();
    locations = [randomUUID(), randomUUID()];
    students = [randomUUID(), randomUUID()];
    for (const [i, id] of locations.entries()) {
      await db.location.create({
        data: { id, name: 'Test', key: randomUUID().slice(0, 7) },
      });
      await db.student.create({
        data: {
          id: students[i],
          registrationId: randomUUID(),
          name: 'Test',
          dob: new Date('2000-01-01'),
          school: i ? 'Other' : 'School',
          district: i ? 'Other' : 'District',
          className: '1',
          medium: 'English',
          syllabus: 'Test',
          parentPhone: '1',
          whatsappPhone: '1',
          locality: 'Test',
          guardianConsentAt: new Date(),
          guardianConsentVersion: '1',
          locationId: id,
        },
      });
    }
  });

  afterAll(async () => {
    if (!db) return;
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

  it('updates and cancels sessions and validates assignments', async () => {
    const id = await makeExam();
    const data = {
      locationId: locations[0],
      ...window(),
      durationMinutes: 3,
      eligibilityType: 'students',
      studentIds: [students[0]],
    };
    await expect(
      service.schedule(id, { ...data, studentIds: [randomUUID()] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const schedule = await service.schedule(id, data);
    expect(await service.listStudent(students[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scheduleId: schedule.id,
          durationMinutes: 3,
        }),
      ]),
    );
    expect(await service.listStudent(students[1])).toEqual([]);
    await service.schedule(
      id,
      { ...data, durationMinutes: 4, studentIds: [students[1]] },
      'admin',
      schedule.id,
    );
    expect(await service.listStudent(students[0])).toEqual([]);
    expect(await service.listStudent(students[1])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scheduleId: schedule.id,
          durationMinutes: 4,
        }),
      ]),
    );
    await service.cancelSchedule(id, schedule.id);
    expect(await service.listStudent(students[1])).toEqual([]);
    await expect(service.start(id, students[1])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('enforces venue and eligibility overlap, allowing adjacent windows', async () => {
    const first = await makeExam(),
      second = await makeExam();
    const start = Date.now() + 900_000;
    const data = {
      locationId: locations[0],
      opensAt: new Date(start).toISOString(),
      closesAt: new Date(start + 60_000).toISOString(),
      eligibilityType: 'school',
      eligibilityValue: 'School',
    };
    const a = await service.schedule(first, data);
    await expect(
      service.schedule(second, { ...data, locationId: locations[1] }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.schedule(second, { ...data, eligibilityValue: 'Other' }),
    ).rejects.toBeInstanceOf(ConflictException);
    const b = await service.schedule(second, {
      ...data,
      opensAt: data.closesAt,
      closesAt: new Date(start + 120_000).toISOString(),
    });
    await service.cancelSchedule(first, a.id);
    await service.cancelSchedule(second, b.id);
  });

  it('serializes competing schedule creations at the same venue', async () => {
    const first = await makeExam(),
      second = await makeExam();
    const data = { locationId: locations[0], ...window() };
    const results = await Promise.allSettled([
      service.schedule(first, data),
      service.schedule(second, data),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winner = results.find((r) => r.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('Missing schedule');
    await service.cancelSchedule(winner.value.examId, winner.value.id);
  });

  it('serializes cancellation with a start', async () => {
    const id = await makeExam();
    const schedule = await service.schedule(id, {
      locationId: locations[0],
      ...window(),
    });
    const [start, cancel] = await Promise.allSettled([
      service.start(id, students[0]),
      service.cancelSchedule(id, schedule.id),
    ]);
    expect([start.status, cancel.status].sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const attempt = await db.examAttempt.findFirst({ where: { examId: id } });
    const stored = await db.examSchedule.findUniqueOrThrow({
      where: { id: schedule.id },
    });
    expect(Boolean(attempt)).toBe(start.status === 'fulfilled');
    expect(Boolean(stored.cancelledAt)).toBe(cancel.status === 'fulfilled');
    if (attempt) {
      await db.examAttempt.delete({ where: { id: attempt.id } });
      await service.cancelSchedule(id, schedule.id);
    }
  });

  it('serializes a start against editing and preserves its deadline and attempt', async () => {
    const id = await makeExam();
    const data = {
      locationId: locations[0],
      ...window(),
      durationMinutes: 2,
      eligibilityType: 'district',
      eligibilityValue: 'District',
    };
    const schedule = await service.schedule(id, data);
    await expect(service.start(id, students[1])).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const results = await Promise.allSettled([
      service.start(id, students[0]),
      service.schedule(
        id,
        { ...data, durationMinutes: 4 },
        'admin',
        schedule.id,
      ),
    ]);
    expect(results[0].status).toBe('fulfilled');
    const attempt = await db.examAttempt.findFirstOrThrow({
      where: { examId: id },
    });
    const updated = await db.examSchedule.findUniqueOrThrow({
      where: { id: schedule.id },
    });
    expect(attempt.deadline.getTime() - attempt.startedAt.getTime()).toBe(
      updated.durationMinutes * 60_000,
    );
    await expect(
      service.cancelSchedule(id, schedule.id),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.schedule(id, data, 'admin', schedule.id),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      await db.examAttempt.findUnique({ where: { id: attempt.id } }),
    ).not.toBeNull();
  });
});
