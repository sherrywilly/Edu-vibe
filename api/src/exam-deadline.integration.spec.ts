import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { ExamDeadlineWorker } from './exam-deadline.worker';
import { ExamService } from './exam.service';

const databaseUrl = process.env.EXAM_TEST_DATABASE_URL;
const redisUrl = process.env.EXAM_TEST_REDIS_URL;
const integration = databaseUrl && redisUrl ? describe : describe.skip;

integration('deadline worker (PostgreSQL and Redis)', () => {
  it('recovers overdue attempts and schedules future attempts without early submission', async () => {
    process.env.DATABASE_URL = databaseUrl;
    const db = new PrismaClient();
    const locationId = randomUUID(),
      studentId = randomUUID(),
      secondStudentId = randomUUID(),
      examId = randomUUID();
    const url = new URL(redisUrl!);
    const queue = new Queue('exam-deadlines', {
      connection: {
        host: url.hostname,
        port: Number(url.port || 6379),
        ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
        ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
        db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
        ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
      },
    });
    const worker = new ExamDeadlineWorker(new ExamService(), redisUrl!);
    try {
      await db.location.create({
        data: { id: locationId, name: 'Test', key: randomUUID().slice(0, 7) },
      });
      for (const id of [studentId, secondStudentId]) {
        await db.student.create({
          data: {
            id,
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
      }
      await db.exam.create({
        data: { id: examId, title: 'Test', durationMinutes: 1 },
      });
      const [{ now }] = await db.$queryRaw<
        { now: Date }[]
      >`SELECT clock_timestamp() AS "now"`;
      const overdue = await db.examAttempt.create({
        data: {
          examId,
          studentId,
          startedAt: now,
          deadline: new Date(now.getTime() - 1000),
        },
      });
      const future = await db.examAttempt.create({
        data: {
          examId,
          studentId: secondStudentId,
          startedAt: now,
          deadline: new Date(now.getTime() + 4000),
        },
      });
      worker.start();
      const until = Date.now() + 10_000;
      while (Date.now() < until && !(await queue.getJob(future.id)))
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await queue.getJob(future.id)).toBeDefined();
      expect(
        (await db.examAttempt.findUniqueOrThrow({ where: { id: future.id } }))
          .submittedAt,
      ).toBeNull();
      while (
        Date.now() < until &&
        !(await db.examAttempt.findUniqueOrThrow({ where: { id: future.id } }))
          .submittedAt
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(
        (await db.examAttempt.findUniqueOrThrow({ where: { id: overdue.id } }))
          .submittedAt,
      ).toBeInstanceOf(Date);
      expect(
        (await db.examAttempt.findUniqueOrThrow({ where: { id: future.id } }))
          .submittedAt,
      ).toBeInstanceOf(Date);
    } finally {
      await worker.close();
      await queue.close();
      await db.examAttempt.deleteMany({ where: { examId } });
      await db.exam.deleteMany({ where: { id: examId } });
      await db.student.deleteMany({
        where: { id: { in: [studentId, secondStudentId] } },
      });
      await db.location.deleteMany({ where: { id: locationId } });
      await db.$disconnect();
    }
  }, 15_000);
});
