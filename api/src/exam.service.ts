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
import { scoreExam, validateScoringFields } from './exam-scoring';
import {
  answersToCanonical,
  answersToDisplayed,
  createAttemptLayout,
  renderAttemptQuestions,
  type RandomizationQuestion,
} from './exam-randomization';

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
      passingScore?: unknown;
      shuffleQuestions?: unknown;
      shuffleOptions?: unknown;
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
      b.questions.length > 500 ||
      (b.shuffleQuestions !== undefined &&
        typeof b.shuffleQuestions !== 'boolean') ||
      (b.shuffleOptions !== undefined && typeof b.shuffleOptions !== 'boolean')
    )
      throw new BadRequestException('Invalid exam.');
    const questions = b.questions.map((q: unknown, position: number) => {
      const item = q as {
        prompt?: unknown;
        options?: unknown;
        correctOption?: unknown;
        subject?: unknown;
        marks?: unknown;
        negativeMarks?: unknown;
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
      let scoring: ReturnType<typeof validateScoringFields>;
      try {
        scoring = validateScoringFields(item);
      } catch {
        throw new BadRequestException('Invalid question scoring.');
      }
      return {
        position,
        prompt: item.prompt.trim(),
        options: item.options as string[],
        correctOption: item.correctOption as number,
        ...scoring,
      };
    });
    let passingScore: number | null;
    try {
      passingScore = scoreExam(
        questions.map((question) => ({
          ...question,
          id: String(question.position),
        })),
        [],
        b.passingScore as number | null | undefined,
      ).passingScore;
    } catch {
      throw new BadRequestException('Invalid exam scoring.');
    }
    const title = b.title.trim();
    return this.db.$transaction(async (tx) => {
      const exam = await tx.exam.create({
        data: {
          title,
          durationMinutes: b.durationMinutes as number,
          passingScore,
          shuffleQuestions: b.shuffleQuestions === true,
          shuffleOptions: b.shuffleOptions === true,
          questions: { create: questions },
        },
        select: {
          id: true,
          title: true,
          durationMinutes: true,
          passingScore: true,
          shuffleQuestions: true,
          shuffleOptions: true,
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
        shuffleQuestions: true,
        shuffleOptions: true,
        passingScore: true,
        resultsPublished: true,
        createdAt: true,
        schedules: {
          select: {
            id: true,
            locationId: true,
            opensAt: true,
            closesAt: true,
            durationMinutes: true,
            eligibilityType: true,
            eligibilityValue: true,
            cancelledAt: true,
            selectedStudents: { select: { studentId: true } },
          },
        },
        questions: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            prompt: true,
            options: true,
            subject: true,
            marks: true,
            negativeMarks: true,
          },
        },
      },
    });
  }

  private parseSchedule(body: unknown) {
    const b = body as {
      locationId?: unknown;
      opensAt?: unknown;
      closesAt?: unknown;
      durationMinutes?: unknown;
      eligibilityType?: unknown;
      eligibilityValue?: unknown;
      studentIds?: unknown;
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
    const type = b.eligibilityType ?? 'location';
    if (
      !['location', 'school', 'district', 'students'].includes(type as string)
    )
      throw new BadRequestException('Invalid eligibility type.');
    if (
      b.durationMinutes !== undefined &&
      (!Number.isInteger(b.durationMinutes) ||
        (b.durationMinutes as number) < 1 ||
        (b.durationMinutes as number) > 10080)
    )
      throw new BadRequestException('Invalid duration.');
    if (
      (type === 'school' || type === 'district') &&
      (typeof b.eligibilityValue !== 'string' ||
        !b.eligibilityValue.trim() ||
        b.eligibilityValue.length > 200)
    )
      throw new BadRequestException('Invalid eligibility value.');
    if (
      (type === 'location' || type === 'students') &&
      b.eligibilityValue != null
    )
      throw new BadRequestException('Invalid eligibility value.');
    if (
      type === 'students' &&
      (!Array.isArray(b.studentIds) ||
        !b.studentIds.length ||
        b.studentIds.length > 5000 ||
        b.studentIds.some((id: unknown) => typeof id !== 'string' || !id) ||
        new Set(b.studentIds).size !== b.studentIds.length)
    )
      throw new BadRequestException('Invalid selected students.');
    if (type !== 'students' && b.studentIds !== undefined)
      throw new BadRequestException('Invalid selected students.');
    return {
      locationId: b.locationId,
      opensAt,
      closesAt,
      durationMinutes: b.durationMinutes as number | undefined,
      eligibilityType: type as string,
      eligibilityValue:
        typeof b.eligibilityValue === 'string'
          ? b.eligibilityValue.trim()
          : null,
      studentIds: (b.studentIds ?? []) as string[],
    };
  }

  private async scheduleLock(tx: Tx, shared = false) {
    if (shared)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(395671, 1)`;
    else await tx.$executeRaw`SELECT pg_advisory_xact_lock(395671, 1)`;
  }

  async schedule(
    examId: string,
    body: unknown,
    actor = 'bootstrap-admin',
    scheduleId?: string,
  ) {
    const data = this.parseSchedule(body);
    return this.db.$transaction(async (tx) => {
      await this.scheduleLock(tx);
      const exam = await tx.exam.findUnique({
        where: { id: examId },
        select: { durationMinutes: true },
      });
      if (
        !exam ||
        !(await tx.location.findUnique({
          where: { id: data.locationId },
          select: { id: true },
        }))
      )
        throw new NotFoundException('Exam or location not found.');
      if (scheduleId) {
        const old = await tx.examSchedule.findFirst({
          where: { id: scheduleId, examId, cancelledAt: null },
        });
        if (!old) throw new NotFoundException('Schedule not found.');
      }
      if (
        await tx.examAttempt.findFirst({
          where: { examId },
          select: { id: true },
        })
      )
        throw new ConflictException(
          'Schedules cannot change after an attempt exists.',
        );
      if (
        data.studentIds.length &&
        (await tx.student.count({ where: { id: { in: data.studentIds } } })) !==
          data.studentIds.length
      )
        throw new BadRequestException('Selected student not found.');
      const overlaps = await tx.examSchedule.findMany({
        where: {
          cancelledAt: null,
          id: scheduleId ? { not: scheduleId } : undefined,
          opensAt: { lt: data.closesAt },
          closesAt: { gt: data.opensAt },
        },
        include: { selectedStudents: { select: { studentId: true } } },
      });
      const overlap = overlaps.some((s) => {
        if (s.locationId === data.locationId) return true;
        if (s.eligibilityType !== data.eligibilityType) return true;
        if (s.eligibilityType === 'location') return false;
        if (s.eligibilityType === 'students')
          return s.selectedStudents.some(({ studentId }) =>
            data.studentIds.includes(studentId),
          );
        return s.eligibilityValue === data.eligibilityValue;
      });
      if (overlap)
        throw new ConflictException(
          'Exam schedule overlaps a venue or potentially eligible students.',
        );
      const fields = {
        locationId: data.locationId,
        opensAt: data.opensAt,
        closesAt: data.closesAt,
        durationMinutes: data.durationMinutes ?? exam.durationMinutes,
        eligibilityType: data.eligibilityType,
        eligibilityValue: data.eligibilityValue,
      };
      if (scheduleId)
        await tx.examScheduleStudent.deleteMany({ where: { scheduleId } });
      const schedule = scheduleId
        ? await tx.examSchedule.update({
            where: { id: scheduleId },
            data: fields,
          })
        : await tx.examSchedule.create({ data: { ...fields, examId } });
      if (data.studentIds.length)
        await tx.examScheduleStudent.createMany({
          data: data.studentIds.map((studentId) => ({
            scheduleId: schedule.id,
            studentId,
          })),
        });
      await tx.auditLog.create({
        data: {
          action: scheduleId ? 'exam.schedule.updated' : 'exam.scheduled',
          actor,
          target: examId,
        },
      });
      return { ...schedule, studentIds: data.studentIds };
    });
  }

  async cancelSchedule(
    examId: string,
    scheduleId: string,
    actor = 'bootstrap-admin',
  ) {
    return this.db.$transaction(async (tx) => {
      await this.scheduleLock(tx);
      const schedule = await tx.examSchedule.findFirst({
        where: { id: scheduleId, examId, cancelledAt: null },
      });
      if (!schedule) throw new NotFoundException('Schedule not found.');
      if (
        await tx.examAttempt.findFirst({
          where: { examId },
          select: { id: true },
        })
      )
        throw new ConflictException(
          'Schedules cannot change after an attempt exists.',
        );
      const updated = await tx.examSchedule.update({
        where: { id: scheduleId },
        data: { cancelledAt: await this.now(tx) },
      });
      await tx.auditLog.create({
        data: { action: 'exam.schedule.cancelled', actor, target: examId },
      });
      return updated;
    });
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
      select: { locationId: true, school: true, district: true },
    });
    if (!student) throw new UnauthorizedException();
    const schedules = await this.db.examSchedule.findMany({
      where: {
        cancelledAt: null,
        OR: [
          { eligibilityType: 'location', locationId: student.locationId },
          { eligibilityType: 'school', eligibilityValue: student.school },
          { eligibilityType: 'district', eligibilityValue: student.district },
          {
            eligibilityType: 'students',
            selectedStudents: { some: { studentId } },
          },
        ],
      },
      include: {
        exam: {
          include: {
            attempts: { where: { studentId } },
            questions: { select: { marks: true } },
          },
        },
      },
      orderBy: { opensAt: 'asc' },
    });
    const [{ now: serverNow }] = await this.db.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS "now"`;
    return schedules.map(
      ({ id: scheduleId, exam, opensAt, closesAt, durationMinutes }) => {
        const attempt = exam.attempts[0];
        return {
          id: exam.id,
          scheduleId,
          title: exam.title,
          durationMinutes,
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
                  ? {
                      score: attempt.score,
                      total: exam.questions.reduce(
                        (sum, q) => sum + q.marks,
                        0,
                      ),
                      passingScore: exam.passingScore,
                      passed:
                        exam.passingScore === null || attempt.score === null
                          ? null
                          : attempt.score >= exam.passingScore,
                    }
                  : {}),
              }
            : null,
        };
      },
    );
  }

  private async finalize(tx: Tx, attemptId: string, now: Date) {
    const attempt = await tx.examAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      include: { answers: true, exam: { include: { questions: true } } },
    });
    if (attempt.submittedAt) return;
    const { score } = scoreExam(
      attempt.exam.questions,
      attempt.answers,
      attempt.exam.passingScore,
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

  private attemptLayout(
    questions: RandomizationQuestion[],
    layout: Prisma.JsonValue | null,
  ) {
    return layout === null ? createAttemptLayout(questions) : layout;
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
              select: {
                id: true,
                prompt: true,
                options: true,
                subject: true,
                marks: true,
                negativeMarks: true,
                correctOption: true,
              },
            },
          },
        },
      },
    });
    const questions = attempt.exam.questions;
    const layout = this.attemptLayout(questions, attempt.randomizationLayout);
    const metadata = new Map(questions.map((q) => [q.id, q]));
    const displayedQuestions = renderAttemptQuestions(questions, layout).map(
      (question) => {
        const { subject, marks, negativeMarks } = metadata.get(question.id)!;
        return { ...question, subject, marks, negativeMarks };
      },
    );
    return {
      id: attempt.id,
      examId: attempt.examId,
      status: attempt.submittedAt ? 'submitted' : 'in_progress',
      startedAt: attempt.startedAt,
      deadline: attempt.deadline,
      serverNow: await this.now(tx),
      revision: attempt.revision,
      questions: displayedQuestions,
      answers: answersToDisplayed(questions, layout, attempt.answers),
      ...(attempt.exam.resultsPublished && attempt.submittedAt
        ? (() => {
            const breakdown = scoreExam(
              attempt.exam.questions,
              attempt.answers,
              attempt.exam.passingScore,
            );
            return { score: attempt.score, total: breakdown.total, breakdown };
          })()
        : {}),
    };
  }

  async start(examId: string, studentId: string) {
    return this.db.$transaction(async (tx) => {
      await this.scheduleLock(tx, true);
      const students = await tx.$queryRaw<
        { id: string; locationId: string; school: string; district: string }[]
      >`SELECT "id", "locationId", "school", "district" FROM "Student" WHERE "id" = ${studentId} FOR UPDATE`;
      if (!students.length) throw new UnauthorizedException();
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
      const eligibility: Prisma.ExamScheduleWhereInput[] = [
        { eligibilityType: 'location', locationId: students[0].locationId },
        { eligibilityType: 'school', eligibilityValue: students[0].school },
        { eligibilityType: 'district', eligibilityValue: students[0].district },
        {
          eligibilityType: 'students',
          selectedStudents: { some: { studentId } },
        },
      ];
      const nowForSchedule = await this.now(tx);
      const schedule = await tx.examSchedule.findFirst({
        where: {
          examId,
          cancelledAt: null,
          OR: eligibility,
          opensAt: { lte: nowForSchedule },
          closesAt: { gt: nowForSchedule },
        },
        orderBy: { opensAt: 'asc' },
      });
      if (!schedule) {
        if (
          await tx.examSchedule.findFirst({
            where: { examId, cancelledAt: null, OR: eligibility },
            select: { id: true },
          })
        )
          throw new ConflictException('Exam is not open.');
        throw new NotFoundException();
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
            LEAST(s."closesAt", clock.now + s."durationMinutes" * INTERVAL '1 minute')
          FROM "ExamSchedule" s CROSS JOIN clock
          WHERE s."id" = ${schedule.id} AND clock.now >= s."opensAt" AND clock.now < s."closesAt"
          RETURNING "id"`;
      if (!created.length) throw new ConflictException('Exam is not open.');
      const exam = await tx.exam.findUniqueOrThrow({
        where: { id: examId },
        select: {
          shuffleQuestions: true,
          shuffleOptions: true,
          questions: {
            orderBy: { position: 'asc' },
            select: { id: true, prompt: true, options: true },
          },
        },
      });
      const layout = createAttemptLayout(exam.questions, exam);
      await tx.examAttempt.update({
        where: { id },
        data: { randomizationLayout: layout },
      });
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
          include: {
            exam: { include: { questions: { orderBy: { position: 'asc' } } } },
          },
        });
        const now = await this.now(tx);
        if (!attempt.submittedAt && now >= attempt.deadline)
          await this.finalize(tx, id, now);
        if (attempt.submittedAt || now >= attempt.deadline) return null;
        if (attempt.revision !== b.revision)
          throw new ConflictException('Revision conflict.');
        const questions = attempt.exam.questions;
        const layout = this.attemptLayout(
          questions,
          attempt.randomizationLayout,
        );
        renderAttemptQuestions(questions, layout);
        let canonical: AnswerInput[];
        try {
          canonical = answersToCanonical(questions, layout, answers);
        } catch {
          throw new BadRequestException('Invalid answer question or option.');
        }
        await tx.examAnswer.deleteMany({ where: { attemptId: id } });
        const selected = canonical.filter((a) => a.option !== null);
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
