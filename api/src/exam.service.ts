import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import type { Request } from 'express';

type Tx = Prisma.TransactionClient;
type AnswerInput = { questionId: string; option: number | null };
class DeadlinePassed extends Error {}

@Injectable()
export class ExamService implements OnModuleInit, OnModuleDestroy {
  private readonly db = new PrismaClient();
  private readonly logger = new Logger(ExamService.name);
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  onModuleInit() {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), 30_000);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.db.$disconnect();
  }

  async authenticate(
    req: Request,
    role: 'admin' | 'student',
    mutation = false,
  ) {
    if (
      mutation &&
      (!process.env.WEB_ORIGIN || req.headers.origin !== process.env.WEB_ORIGIN)
    ) {
      throw new ForbiddenException('Invalid request origin.');
    }
    const token = req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('edu_session='))
      ?.slice(12);
    if (!token || !/^[a-f0-9]{64}$/.test(token))
      throw new UnauthorizedException();
    const session = await this.db.session.findUnique({
      where: { id: createHash('sha256').update(token).digest('hex') },
    });
    if (
      !session ||
      session.role !== role ||
      session.expiresAt <= new Date() ||
      (role === 'student' && !session.studentId)
    )
      throw new UnauthorizedException();
    return session;
  }

  private async now(tx: Tx) {
    const rows = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS "now"`;
    return rows[0].now;
  }

  async createExam(body: unknown, actor = 'bootstrap-admin') {
    const b = body as {
      title?: unknown;
      durationMinutes?: unknown;
      questions?: unknown;
    } | null;
    if (
      !b ||
      typeof b.title !== 'string' ||
      !b.title.trim() ||
      b.title.length > 200 ||
      !Number.isInteger(b.durationMinutes) ||
      (b.durationMinutes as number) < 1 ||
      (b.durationMinutes as number) > 10080 ||
      !Array.isArray(b.questions) ||
      b.questions.length < 1 ||
      b.questions.length > 500
    )
      throw new BadRequestException('Invalid exam.');
    const questions = b.questions.map((q: unknown, position: number) => {
      const item = q as {
        prompt?: unknown;
        options?: unknown;
        correctOption?: unknown;
      } | null;
      if (
        !item ||
        typeof item.prompt !== 'string' ||
        !item.prompt.trim() ||
        item.prompt.length > 5000 ||
        !Array.isArray(item.options) ||
        item.options.length < 2 ||
        item.options.length > 10 ||
        item.options.some(
          (o: unknown) => typeof o !== 'string' || !o.trim() || o.length > 1000,
        ) ||
        !Number.isInteger(item.correctOption) ||
        (item.correctOption as number) < 0 ||
        (item.correctOption as number) >= item.options.length
      ) {
        throw new BadRequestException('Invalid question.');
      }
      return {
        position,
        prompt: item.prompt.trim(),
        options: item.options as string[],
        correctOption: item.correctOption as number,
      };
    });
    const title = b.title.trim();
    return this.db.$transaction(async (tx) => {
      const exam = await tx.exam.create({
        data: {
          title,
          durationMinutes: b.durationMinutes as number,
          questions: { create: questions },
        },
        select: {
          id: true,
          title: true,
          durationMinutes: true,
          resultsPublished: true,
          createdAt: true,
        },
      });
      await tx.auditLog.create({
        data: { action: 'exam.created', actor, target: exam.id },
      });
      return exam;
    });
  }

  async listAdmin() {
    return this.db.exam.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        durationMinutes: true,
        resultsPublished: true,
        createdAt: true,
        schedules: {
          select: { id: true, locationId: true, opensAt: true, closesAt: true },
        },
        questions: {
          orderBy: { position: 'asc' },
          select: { id: true, prompt: true, options: true },
        },
      },
    });
  }

  async schedule(examId: string, body: unknown, actor = 'bootstrap-admin') {
    const b = body as {
      locationId?: unknown;
      opensAt?: unknown;
      closesAt?: unknown;
    } | null;
    if (
      !b ||
      typeof b.locationId !== 'string' ||
      typeof b.opensAt !== 'string' ||
      typeof b.closesAt !== 'string'
    )
      throw new BadRequestException('Invalid schedule.');
    const instant = (value: string) => {
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          value,
        )
      )
        throw new BadRequestException('Dates must include a timezone.');
      const datePart = value.slice(0, 10);
      const date = new Date(`${datePart}T00:00:00Z`);
      if (
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== datePart
      )
        throw new BadRequestException('Invalid schedule date.');
      return new Date(value);
    };
    const opensAt = instant(b.opensAt),
      closesAt = instant(b.closesAt);
    if (
      !Number.isFinite(opensAt.getTime()) ||
      !Number.isFinite(closesAt.getTime()) ||
      opensAt >= closesAt
    )
      throw new BadRequestException('Invalid schedule window.');
    try {
      const locationId = b.locationId;
      return await this.db.$transaction(async (tx) => {
        const locations = await tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "Location" WHERE "id" = ${locationId} FOR UPDATE`;
        if (
          !locations.length ||
          !(await tx.exam.findUnique({
            where: { id: examId },
            select: { id: true },
          }))
        )
          throw new NotFoundException('Exam or location not found.');
        const overlap = await tx.examSchedule.findFirst({
          where: {
            locationId,
            opensAt: { lt: closesAt },
            closesAt: { gt: opensAt },
          },
          select: { id: true },
        });
        if (overlap)
          throw new ConflictException(
            'Exam schedule overlaps another exam at this location.',
          );
        const schedule = await tx.examSchedule.create({
          data: { examId, locationId, opensAt, closesAt },
        });
        await tx.auditLog.create({
          data: { action: 'exam.scheduled', actor, target: examId },
        });
        return schedule;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException('Location already scheduled.');
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      )
        throw new NotFoundException('Exam or location not found.');
      throw error;
    }
  }

  async publish(examId: string, body: unknown, actor = 'bootstrap-admin') {
    const b = body as { published?: unknown } | null;
    if (!b || typeof b.published !== 'boolean')
      throw new BadRequestException('Invalid publication state.');
    const published = b.published;
    return this.db.$transaction(async (tx) => {
      const updated = await tx.exam.updateMany({
        where: { id: examId },
        data: { resultsPublished: published },
      });
      if (!updated.count) throw new NotFoundException();
      await tx.auditLog.create({
        data: {
          action: published
            ? 'exam.results.published'
            : 'exam.results.unpublished',
          actor,
          target: examId,
        },
      });
      return { id: examId, resultsPublished: published };
    });
  }

  async listStudent(studentId: string) {
    const student = await this.db.student.findUnique({
      where: { id: studentId },
      select: { locationId: true },
    });
    if (!student) throw new UnauthorizedException();
    const schedules = await this.db.examSchedule.findMany({
      where: { locationId: student.locationId },
      include: {
        exam: {
          include: {
            attempts: { where: { studentId } },
            _count: { select: { questions: true } },
          },
        },
      },
      orderBy: { opensAt: 'asc' },
    });
    const [{ now: serverNow }] = await this.db.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS "now"`;
    return schedules.map(({ exam, opensAt, closesAt }) => {
      const attempt = exam.attempts[0];
      return {
        id: exam.id,
        title: exam.title,
        durationMinutes: exam.durationMinutes,
        opensAt,
        closesAt,
        serverNow,
        resultsPublished: exam.resultsPublished,
        attempt: attempt
          ? {
              id: attempt.id,
              status: attempt.submittedAt ? 'submitted' : 'in_progress',
              deadline: attempt.deadline,
              ...(exam.resultsPublished && attempt.submittedAt
                ? { score: attempt.score, total: exam._count.questions }
                : {}),
            }
          : null,
      };
    });
  }

  private async finalize(tx: Tx, attemptId: string, now: Date) {
    const attempt = await tx.examAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      include: { answers: true, exam: { include: { questions: true } } },
    });
    if (attempt.submittedAt) return;
    const answerMap = new Map(
      attempt.answers.map((a) => [a.questionId, a.option]),
    );
    const score = attempt.exam.questions.reduce(
      (sum, q) => sum + (answerMap.get(q.id) === q.correctOption ? 1 : 0),
      0,
    );
    await tx.examAttempt.update({
      where: { id: attemptId },
      data: { submittedAt: now, score },
    });
  }

  private async lockAttempt(tx: Tx, id: string, studentId?: string) {
    const rows = studentId
      ? await tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "ExamAttempt" WHERE "id" = ${id} AND "studentId" = ${studentId} FOR UPDATE`
      : await tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "ExamAttempt" WHERE "id" = ${id} FOR UPDATE`;
    if (!rows.length) throw new NotFoundException();
  }

  private async render(tx: Tx, attemptId: string) {
    const attempt = await tx.examAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      include: {
        answers: { select: { questionId: true, option: true } },
        exam: {
          include: {
            questions: {
              orderBy: { position: 'asc' },
              select: { id: true, prompt: true, options: true },
            },
          },
        },
      },
    });
    return {
      id: attempt.id,
      examId: attempt.examId,
      status: attempt.submittedAt ? 'submitted' : 'in_progress',
      startedAt: attempt.startedAt,
      deadline: attempt.deadline,
      serverNow: await this.now(tx),
      revision: attempt.revision,
      questions: attempt.exam.questions,
      answers: attempt.answers,
      ...(attempt.exam.resultsPublished && attempt.submittedAt
        ? { score: attempt.score, total: attempt.exam.questions.length }
        : {}),
    };
  }

  async start(examId: string, studentId: string) {
    return this.db.$transaction(async (tx) => {
      const students = await tx.$queryRaw<
        { id: string; locationId: string }[]
      >`SELECT "id", "locationId" FROM "Student" WHERE "id" = ${studentId} FOR UPDATE`;
      if (!students.length) throw new UnauthorizedException();
      const schedule = await tx.examSchedule.findUnique({
        where: {
          examId_locationId: { examId, locationId: students[0].locationId },
        },
        include: { exam: true },
      });
      if (!schedule) throw new NotFoundException();
      const existing = await tx.examAttempt.findUnique({
        where: { examId_studentId: { examId, studentId } },
      });
      if (existing) {
        await this.lockAttempt(tx, existing.id, studentId);
        const now = await this.now(tx);
        if (!existing.submittedAt && now >= existing.deadline)
          await this.finalize(tx, existing.id, now);
        return this.render(tx, existing.id);
      }
      const active = await tx.$queryRaw<
        { id: string; deadline: Date }[]
      >`SELECT "id", "deadline" FROM "ExamAttempt" WHERE "studentId" = ${studentId} AND "submittedAt" IS NULL ORDER BY "id" FOR UPDATE`;
      const now = await this.now(tx);
      for (const attempt of active) {
        if (now >= attempt.deadline) await this.finalize(tx, attempt.id, now);
        else
          throw new ConflictException('Another exam attempt is in progress.');
      }
      const id = randomUUID();
      const created = await tx.$queryRaw<{ id: string }[]>`
          WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now)
          INSERT INTO "ExamAttempt" ("id", "examId", "studentId", "startedAt", "deadline")
          SELECT ${id}, ${examId}, ${studentId}, clock.now,
            LEAST(s."closesAt", clock.now + e."durationMinutes" * INTERVAL '1 minute')
          FROM "ExamSchedule" s JOIN "Exam" e ON e."id" = s."examId" CROSS JOIN clock
          WHERE s."id" = ${schedule.id} AND clock.now >= s."opensAt" AND clock.now < s."closesAt"
          RETURNING "id"`;
      if (!created.length) throw new ConflictException('Exam is not open.');
      return this.render(tx, id);
    });
  }

  async getAttempt(id: string, studentId: string) {
    return this.db.$transaction(async (tx) => {
      await this.lockAttempt(tx, id, studentId);
      const attempt = await tx.examAttempt.findUniqueOrThrow({ where: { id } });
      const now = await this.now(tx);
      if (!attempt.submittedAt && now >= attempt.deadline)
        await this.finalize(tx, id, now);
      return this.render(tx, id);
    });
  }

  async save(id: string, studentId: string, body: unknown) {
    const b = body as { revision?: unknown; answers?: unknown } | null;
    if (
      !b ||
      !Number.isSafeInteger(b.revision) ||
      (b.revision as number) < 0 ||
      !Array.isArray(b.answers) ||
      b.answers.length > 500
    )
      throw new BadRequestException('Invalid answers.');
    const answers = b.answers as AnswerInput[];
    if (
      answers.some(
        (a) =>
          !a ||
          typeof a.questionId !== 'string' ||
          !(a.option === null || (Number.isInteger(a.option) && a.option >= 0)),
      ) ||
      new Set(answers.map((a) => a.questionId)).size !== answers.length
    )
      throw new BadRequestException('Invalid answers.');
    let result: Awaited<ReturnType<ExamService['render']>> | null;
    try {
      result = await this.db.$transaction(async (tx) => {
        await this.lockAttempt(tx, id, studentId);
        const attempt = await tx.examAttempt.findUniqueOrThrow({
          where: { id },
          include: { exam: { include: { questions: true } } },
        });
        const now = await this.now(tx);
        if (!attempt.submittedAt && now >= attempt.deadline)
          await this.finalize(tx, id, now);
        if (attempt.submittedAt || now >= attempt.deadline) return null;
        if (attempt.revision !== b.revision)
          throw new ConflictException('Revision conflict.');
        const questions = new Map(attempt.exam.questions.map((q) => [q.id, q]));
        if (
          answers.some((a) => {
            const q = questions.get(a.questionId);
            return (
              !q ||
              (a.option !== null &&
                (!Array.isArray(q.options) || a.option >= q.options.length))
            );
          })
        )
          throw new BadRequestException('Invalid answer question or option.');
        await tx.examAnswer.deleteMany({ where: { attemptId: id } });
        const selected = answers.filter((a) => a.option !== null);
        if (selected.length)
          await tx.examAnswer.createMany({
            data: selected.map((a) => ({
              attemptId: id,
              questionId: a.questionId,
              option: a.option!,
            })),
          });
        const updated =
          await tx.$executeRaw`UPDATE "ExamAttempt" SET "revision" = "revision" + 1 WHERE "id" = ${id} AND "submittedAt" IS NULL AND "deadline" > (clock_timestamp() AT TIME ZONE 'UTC')`;
        if (!updated) throw new DeadlinePassed();
        return this.render(tx, id);
      });
    } catch (error) {
      if (!(error instanceof DeadlinePassed)) throw error;
      await this.getAttempt(id, studentId);
      throw new ConflictException('Attempt is closed.');
    }
    if (!result) throw new ConflictException('Attempt is closed.');
    return result;
  }

  async submit(id: string, studentId: string) {
    return this.db.$transaction(async (tx) => {
      await this.lockAttempt(tx, id, studentId);
      await this.finalize(tx, id, await this.now(tx));
      return this.render(tx, id);
    });
  }

  async finalizeDue(id: string): Promise<{ remainingMs: number } | null> {
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "ExamAttempt" WHERE "id" = ${id} FOR UPDATE`;
      if (!rows.length) return null;
      const attempt = await tx.examAttempt.findUniqueOrThrow({ where: { id } });
      if (attempt.submittedAt) return null;
      const now = await this.now(tx);
      if (now < attempt.deadline)
        return { remainingMs: attempt.deadline.getTime() - now.getTime() };
      await this.finalize(tx, id, now);
      return null;
    });
  }

  async pendingDeadlines(after?: string) {
    const attempts = await this.db.examAttempt.findMany({
      where: { submittedAt: null, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: 'asc' },
      take: 100,
      select: { id: true, deadline: true },
    });
    const [{ now }] = await this.db.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS "now"`;
    return attempts.map((attempt) => ({
      id: attempt.id,
      remainingMs: Math.max(0, attempt.deadline.getTime() - now.getTime()),
    }));
  }

  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      // Each row is locked independently so multiple API instances can safely recover attempts.
      for (let i = 0; i < 100; i++) {
        const processed = await this.db.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<
            { id: string }[]
          >`SELECT "id" FROM "ExamAttempt" WHERE "submittedAt" IS NULL AND "deadline" <= (clock_timestamp() AT TIME ZONE 'UTC') ORDER BY "deadline" FOR UPDATE SKIP LOCKED LIMIT 1`;
          if (!rows.length) return false;
          await this.finalize(tx, rows[0].id, await this.now(tx));
          return true;
        });
        if (!processed) break;
      }
    } catch {
      this.logger.error('Exam recovery sweep failed');
    } finally {
      this.sweeping = false;
    }
  }
}
