import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { authenticateAdmin } from './auth';

const eventTypes = [
  'focus',
  'blur',
  'visible',
  'hidden',
  'fullscreen_enter',
  'fullscreen_exit',
] as const;
const eventLimit = 100;

@Injectable()
export class AttemptNotesService implements OnModuleDestroy {
  private readonly db = new PrismaClient();

  async onModuleDestroy() {
    await this.db.$disconnect();
  }

  async authenticateAdmin(req: Request) {
    return authenticateAdmin(this.db, req, [
      'super_admin',
      'exam_manager',
      'reviewer',
    ]);
  }

  async listAttempts(query: Record<string, unknown>) {
    const { page: rawPage, q: rawSearch } = query;
    if (
      (rawPage !== undefined &&
        (typeof rawPage !== 'string' || !/^[1-9]\d{0,4}$/.test(rawPage))) ||
      (rawSearch !== undefined &&
        (typeof rawSearch !== 'string' || rawSearch.length > 200))
    ) {
      throw new BadRequestException('Invalid attempt search or page.');
    }
    const page = rawPage === undefined ? 1 : Number(rawPage);
    const search = typeof rawSearch === 'string' ? rawSearch.trim() : '';
    const where: Prisma.ExamAttemptWhereInput = search
      ? {
          OR: [
            { id: { contains: search, mode: 'insensitive' } },
            {
              student: {
                registrationId: { contains: search, mode: 'insensitive' },
              },
            },
            { student: { name: { contains: search, mode: 'insensitive' } } },
            { exam: { title: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {};
    const pageSize = 20;
    const attempts = await this.db.examAttempt.findMany({
      where,
      select: {
        id: true,
        startedAt: true,
        submittedAt: true,
        student: { select: { registrationId: true, name: true } },
        exam: { select: { title: true } },
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize + 1,
    });
    return {
      attempts: attempts.slice(0, pageSize),
      page,
      hasMore: attempts.length > pageSize,
    };
  }

  async eventSummary(id: string) {
    const attempt = await this.db.examAttempt.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!attempt) throw new NotFoundException();
    const counts = await this.db.$queryRaw<{ type: string; count: number }[]>`
      SELECT "type", COUNT(*)::integer AS "count" FROM "ExamFocusEvent"
      WHERE "attemptId" = ${id} GROUP BY "type" ORDER BY "type"`;
    return {
      attemptId: id,
      total: counts.reduce((total, item) => total + item.count, 0),
      counts,
    };
  }

  private async lock(
    tx: Prisma.TransactionClient,
    id: string,
    studentId: string,
  ) {
    const rows = await tx.$queryRaw<{ id: string; examId: string }[]>`
      SELECT "id", "examId" FROM "ExamAttempt"
      WHERE "id" = ${id} AND "studentId" = ${studentId} FOR UPDATE`;
    if (!rows.length) throw new NotFoundException();
    return rows[0];
  }

  async get(id: string, studentId: string) {
    return this.db.$transaction(async (tx) => {
      await this.lock(tx, id, studentId);
      const flags = await tx.$queryRaw<{ questionId: string }[]>`
        SELECT "questionId" FROM "ExamReviewFlag" WHERE "attemptId" = ${id}`;
      return { flaggedQuestionIds: flags.map((flag) => flag.questionId) };
    });
  }

  async setFlag(
    id: string,
    studentId: string,
    questionId: string,
    body: unknown,
  ) {
    const b = body as { flagged?: unknown } | null;
    if (!b || typeof b.flagged !== 'boolean')
      throw new BadRequestException('Invalid review flag.');
    return this.db.$transaction(async (tx) => {
      const attempt = await this.lock(tx, id, studentId);
      const question = await tx.examQuestion.findFirst({
        where: { id: questionId, examId: attempt.examId },
        select: { id: true },
      });
      if (!question) throw new BadRequestException('Invalid question.');
      const rows = b.flagged
        ? await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO "ExamReviewFlag" ("attemptId", "questionId")
            SELECT a."id", ${questionId} FROM "ExamAttempt" a
            WHERE a."id" = ${id} AND a."submittedAt" IS NULL
              AND a."deadline" > (clock_timestamp() AT TIME ZONE 'UTC')
            ON CONFLICT ("attemptId", "questionId") DO UPDATE SET "questionId" = EXCLUDED."questionId"
            RETURNING "attemptId" AS "id"`
        : await tx.$queryRaw<{ id: string }[]>`
            WITH allowed AS MATERIALIZED (
              SELECT "id" FROM "ExamAttempt" WHERE "id" = ${id}
                AND "submittedAt" IS NULL
                AND "deadline" > (clock_timestamp() AT TIME ZONE 'UTC')
            ), deleted AS (
              DELETE FROM "ExamReviewFlag" WHERE "attemptId" IN (SELECT "id" FROM allowed)
                AND "questionId" = ${questionId}
            )
            SELECT "id" FROM allowed`;
      if (!rows.length) throw new ConflictException('Attempt is closed.');
      return { questionId, flagged: b.flagged };
    });
  }

  async recordEvent(id: string, studentId: string, body: unknown) {
    const b = body as { type?: unknown } | null;
    if (
      !b ||
      typeof b.type !== 'string' ||
      !eventTypes.includes(b.type as (typeof eventTypes)[number])
    )
      throw new BadRequestException('Invalid event type.');
    return this.db.$transaction(async (tx) => {
      await this.lock(tx, id, studentId);
      const eventId = randomUUID();
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "ExamFocusEvent" ("id", "attemptId", "type", "createdAt")
        SELECT ${eventId}, a."id", ${b.type}, (clock_timestamp() AT TIME ZONE 'UTC')
        FROM "ExamAttempt" a
        WHERE a."id" = ${id} AND a."submittedAt" IS NULL
          AND a."deadline" > (clock_timestamp() AT TIME ZONE 'UTC')
          AND (SELECT COUNT(*) FROM "ExamFocusEvent" WHERE "attemptId" = ${id}) < ${eventLimit}
        RETURNING "id"`;
      if (!rows.length)
        throw new ConflictException(
          'Attempt is closed or event limit reached.',
        );
      return { recorded: true };
    });
  }
}
