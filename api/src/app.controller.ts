import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'crypto';
import type { Request, Response } from 'express';
import {
  adminRoles,
  authenticateAdmin,
  hashPassword,
  passwordValue,
  roleValue,
  usernameValue,
  verifyPassword,
} from './auth';
import { validateRegistrationOptions } from './options.service';
import { networkIdentity } from './network';
import { safeWhatsappGroupUrl } from './whatsapp-group';

const db = new PrismaClient();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomKey = () =>
  Array.from({ length: 7 }, () => alphabet[randomInt(alphabet.length)]).join(
    '',
  );
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const text = (value: unknown, max = 120) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new BadRequestException('Please check the required fields.');
  return value.trim();
};
const phone = (value: unknown) => {
  const raw = text(value, 30).replace(/[\s()-]/g, '');
  const normal = raw.startsWith('+') ? raw : `+91${raw}`;
  if (!/^\+[1-9]\d{7,14}$/.test(normal))
    throw new BadRequestException(
      'Please enter a valid phone number with country code.',
    );
  return normal;
};
const date = (value: unknown) => {
  const raw = text(value, 10);
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (!match)
    throw new BadRequestException('Enter date of birth as DD/MM/YYYY.');
  const [, day, month, year] = match;
  const iso = `${year}-${month}-${day}`;
  const result = new Date(`${iso}T00:00:00.000Z`);
  if (
    Number(year) < 1 ||
    !Number.isFinite(result.getTime()) ||
    result.toISOString().slice(0, 10) !== iso
  ) {
    throw new BadRequestException('Enter a valid date of birth.');
  }
  return result;
};
const equal = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const optionalInstant = (value: unknown) => {
  if (value === undefined || value === null || value === '') return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    throw new BadRequestException('Dates must include a timezone.');
  }
  const datePart = value.slice(0, 10);
  const calendarDate = new Date(`${datePart}T00:00:00Z`);
  if (
    !Number.isFinite(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== datePart
  )
    throw new BadRequestException('Enter a valid date and time.');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    throw new BadRequestException('Enter a valid date and time.');
  return parsed;
};

@Controller()
export class AppController {
  private async limit(key: string, max: number, seconds: number) {
    const now = new Date();
    const expires = new Date(now.getTime() + seconds * 1000);
    const secret = process.env.RATE_LIMIT_SECRET;
    if (!secret || secret.length < 32)
      throw new HttpException('Rate limiting is not configured.', 503);
    const limitKey = createHmac('sha256', secret).update(key).digest('hex');
    const rows = await db.$queryRaw<{ count: number }[]>`
      INSERT INTO "RateLimit" ("key", "count", "expiresAt") VALUES (${limitKey}, 1, ${expires})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "RateLimit"."expiresAt" <= ${now} THEN 1 ELSE "RateLimit"."count" + 1 END,
        "expiresAt" = CASE WHEN "RateLimit"."expiresAt" <= ${now} THEN ${expires} ELSE "RateLimit"."expiresAt" END
      RETURNING "count"`;
    if (rows[0].count > max)
      throw new HttpException(
        'Too many requests. Please try again later.',
        429,
      );
    return rows[0].count;
  }

  private csrf(req: Request) {
    if (
      !process.env.WEB_ORIGIN ||
      req.headers.origin !== process.env.WEB_ORIGIN
    )
      throw new ForbiddenException('Invalid request origin.');
  }

  private async session(req: Request, role: string) {
    const token = req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('edu_session='))
      ?.slice(12);
    if (!token || !/^[a-f0-9]{64}$/.test(token))
      throw new UnauthorizedException();
    const session = await db.session.findUnique({ where: { id: hash(token) } });
    if (!session || session.role !== role || session.expiresAt <= new Date())
      throw new UnauthorizedException();
    return session;
  }

  private async createSession(res: Response, role: string, studentId?: string) {
    const token = randomBytes(32).toString('hex');
    await db.session.create({
      data: {
        id: hash(token),
        role,
        studentId,
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      },
    });
    res.cookie('edu_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 60 * 60 * 1000,
    });
  }

  private async location(key: string) {
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{7}$/.test(key))
      throw new NotFoundException('This registration link is invalid.');
    const location = await db.location.findUnique({ where: { key } });
    if (!location)
      throw new NotFoundException('This registration link is invalid.');
    if (!location.active)
      throw new ForbiddenException('This registration link is inactive.');
    const now = new Date();
    if (location.opensAt && location.opensAt > now)
      throw new ForbiddenException('Registration has not opened yet.');
    if (location.closesAt && location.closesAt <= now)
      throw new ForbiddenException('This registration link has expired.');
    return location;
  }

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('locations/:key')
  async resolve(@Param('key') key: string, @Req() req: Request) {
    const network = networkIdentity(req);
    if (network) await this.limit(`lookup:${network}`, 100, 60);
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{7}$/.test(key))
      throw new NotFoundException('This registration link is invalid.');
    await this.limit(`lookup-key:${key}`, 300, 60);
    const location = await this.location(key);
    return { name: location.name };
  }

  @Post('register/:key')
  async register(
    @Param('key') key: string,
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
  ) {
    this.csrf(req);
    const network = networkIdentity(req);
    if (network) await this.limit(`register:${network}`, 20, 3600);
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{7}$/.test(key))
      throw new NotFoundException('This registration link is invalid.');
    await this.limit(`register-key:${key}`, 300, 3600);
    const location = await this.location(key);
    if (body.guardianConsent !== true)
      throw new BadRequestException('Guardian consent is required.');
    const options = await validateRegistrationOptions(body);
    const now = new Date();
    const student = await db.student.create({
      data: {
        registrationId: `EV-${randomBytes(8).toString('hex').toUpperCase()}`,
        name: text(body.name),
        dob: date(body.dob),
        school: options.school,
        district: options.district,
        className: options.className,
        medium: options.medium,
        syllabus: options.syllabus,
        parentPhone: phone(body.parentPhone),
        whatsappPhone: phone(body.whatsappPhone),
        locality: text(body.locality),
        guardianConsentAt: now,
        guardianConsentVersion: '1',
        whatsappConsentAt: body.whatsappConsent === true ? now : null,
        whatsappConsentVersion: body.whatsappConsent === true ? '1' : null,
        locationId: location.id,
      },
      select: {
        registrationId: true,
        location: { select: { name: true, whatsappGroupUrl: true } },
      },
    });
    return {
      registrationId: student.registrationId,
      location: {
        name: student.location.name,
        whatsappGroupUrl: safeWhatsappGroupUrl(
          student.location.whatsappGroupUrl,
        ),
      },
    };
  }

  @Post('student/login')
  async studentLogin(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: Record<string, unknown>,
  ) {
    this.csrf(req);
    const network = networkIdentity(req);
    if (network) await this.limit(`student-login:${network}`, 15, 900);
    let parentPhone: string;
    let dob: Date;
    try {
      parentPhone = phone(body.phone);
      dob = date(body.dob);
    } catch {
      throw new UnauthorizedException(
        'The supplied credentials could not be verified.',
      );
    }
    const attempts = await this.limit(
      `student-account:${parentPhone}`,
      10,
      900,
    );
    if (attempts > 3)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min((attempts - 3) * 250, 1500)),
      );
    const matches = await db.student.findMany({
      where: { parentPhone, dob },
      select: { id: true, registrationId: true },
    });
    if (matches.length > 1 && !body.registrationId)
      return { requiresRegistrationId: true };
    const student =
      matches.length === 1
        ? matches[0]
        : matches.find(
            (s) =>
              typeof body.registrationId === 'string' &&
              equal(s.registrationId, body.registrationId.trim()),
          );
    if (!student)
      throw new UnauthorizedException(
        'The supplied credentials could not be verified.',
      );
    await this.createSession(res, 'student', student.id);
    return { ok: true };
  }

  @Get('student/me')
  async me(@Req() req: Request) {
    const session = await this.session(req, 'student');
    const student = await db.student.findUnique({
      where: { id: session.studentId! },
      select: {
        name: true,
        registrationId: true,
        school: true,
        className: true,
        location: { select: { name: true, whatsappGroupUrl: true } },
      },
    });
    if (!student) throw new UnauthorizedException();
    return {
      ...student,
      location: {
        ...student.location,
        whatsappGroupUrl: safeWhatsappGroupUrl(
          student.location.whatsappGroupUrl,
        ),
      },
    };
  }

  @Post('admin/login')
  async adminLogin(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: Record<string, unknown>,
  ) {
    this.csrf(req);
    const network = networkIdentity(req);
    if (network) await this.limit(`admin-login:${network}`, 10, 900);
    let username: string;
    try {
      username = usernameValue(body?.username);
    } catch {
      throw new UnauthorizedException(
        'The supplied credentials could not be verified.',
      );
    }
    await this.limit(`admin-account:${username}`, 10, 900);
    const admin = await db.adminAccount.findUnique({ where: { username } });
    const candidate = typeof body.password === 'string' ? body.password : '';
    const dummy = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;
    if (
      !(await verifyPassword(candidate, admin?.passwordHash ?? dummy)) ||
      !admin ||
      !adminRoles.includes(admin.role as never)
    ) {
      throw new UnauthorizedException(
        'The supplied credentials could not be verified.',
      );
    }
    const token = randomBytes(32).toString('hex');
    const safeAdmin = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "AdminAccount" WHERE "id" = ${admin.id} FOR UPDATE`;
      if (!rows.length) throw new UnauthorizedException();
      const current = await tx.adminAccount.findUnique({
        where: { id: admin.id },
      });
      if (
        !current ||
        current.passwordHash !== admin.passwordHash ||
        !adminRoles.includes(current.role as never)
      )
        throw new UnauthorizedException();
      await tx.session.create({
        data: {
          id: hash(token),
          role: 'admin',
          adminId: current.id,
          expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
        },
      });
      await tx.auditLog.create({
        data: { action: 'admin.login', actor: current.id },
      });
      return { id: current.id, username: current.username, role: current.role };
    });
    res.cookie('edu_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 60 * 60 * 1000,
    });
    return { ok: true, admin: safeAdmin };
  }

  @Get('admin/me')
  async adminMe(@Req() req: Request) {
    return authenticateAdmin(db, req);
  }

  @Post('admin/change-password')
  async changePassword(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = await authenticateAdmin(db, req, adminRoles, true);
    await this.limit(`admin-password:${actor.id}`, 10, 900);
    const newPassword = passwordValue(body?.newPassword);
    const account = await db.adminAccount.findUnique({
      where: { id: actor.id },
    });
    if (
      !account ||
      typeof body.currentPassword !== 'string' ||
      !(await verifyPassword(body.currentPassword, account.passwordHash))
    ) {
      throw new UnauthorizedException(
        'The supplied credentials could not be verified.',
      );
    }
    const passwordHash = await hashPassword(newPassword);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "AdminAccount" WHERE "id" = ${actor.id} FOR UPDATE`;
      const current = await tx.adminAccount.findUnique({
        where: { id: actor.id },
      });
      if (!current || current.passwordHash !== account.passwordHash)
        throw new UnauthorizedException();
      await tx.adminAccount.update({
        where: { id: actor.id },
        data: { passwordHash },
      });
      await tx.session.deleteMany({ where: { adminId: actor.id } });
      await tx.auditLog.create({
        data: {
          action: 'admin.password.changed',
          actor: actor.id,
          target: actor.id,
        },
      });
    });
    res.clearCookie('edu_session', { path: '/' });
    return { ok: true };
  }

  @Get('admin/accounts')
  async accounts(@Req() req: Request) {
    await authenticateAdmin(db, req, ['super_admin']);
    return db.adminAccount.findMany({
      select: { id: true, username: true, role: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  @Post('admin/accounts')
  async createAccount(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = await authenticateAdmin(db, req, ['super_admin'], true);
    const username = usernameValue(body?.username);
    const role = roleValue(body?.role);
    const passwordHash = await hashPassword(passwordValue(body?.password));
    try {
      return await db.$transaction(async (tx) => {
        const account = await tx.adminAccount.create({
          data: { username, role, passwordHash },
          select: { id: true, username: true, role: true, createdAt: true },
        });
        await tx.auditLog.create({
          data: {
            action: 'admin.created',
            actor: actor.id,
            target: account.id,
          },
        });
        return account;
      });
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error &&
        'code' in error &&
        error.code === 'P2002'
      )
        throw new ConflictException('Username already exists.');
      throw error;
    }
  }

  @Patch('admin/accounts/:id')
  async updateAccount(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = await authenticateAdmin(db, req, ['super_admin'], true);
    if (!body || (body.role === undefined && body.password === undefined))
      throw new BadRequestException('No changes supplied.');
    const role = body.role === undefined ? undefined : roleValue(body.role);
    const passwordHash =
      body.password === undefined
        ? undefined
        : await hashPassword(passwordValue(body.password));
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(473921, 1)::text`;
      await tx.$queryRaw`SELECT "id" FROM "AdminAccount" WHERE "id" = ${id} FOR UPDATE`;
      const current = await tx.adminAccount.findUnique({ where: { id } });
      if (!current) throw new NotFoundException();
      if (
        current.role === 'super_admin' &&
        role &&
        role !== 'super_admin' &&
        (await tx.adminAccount.count({ where: { role: 'super_admin' } })) <= 1
      ) {
        throw new ConflictException('At least one super admin is required.');
      }
      const account = await tx.adminAccount.update({
        where: { id },
        data: { role, passwordHash },
        select: { id: true, username: true, role: true, createdAt: true },
      });
      if (passwordHash || (role && role !== current.role))
        await tx.session.deleteMany({ where: { adminId: id } });
      await tx.auditLog.create({
        data: { action: 'admin.updated', actor: actor.id, target: id },
      });
      return account;
    });
  }

  @Get('admin/locations')
  async locations(@Req() req: Request) {
    await authenticateAdmin(db, req);
    const locations = await db.location.findMany({
      include: { _count: { select: { students: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return locations.map((location) => ({
      ...location,
      whatsappGroupUrl: safeWhatsappGroupUrl(location.whatsappGroupUrl),
    }));
  }

  @Patch('admin/locations/:id/whatsapp-group')
  async updateWhatsappGroup(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const actor = await authenticateAdmin(
      db,
      req,
      ['super_admin', 'exam_manager'],
      true,
    );
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !Object.hasOwn(body, 'whatsappGroupUrl') ||
      Object.keys(body).length !== 1
    )
      throw new BadRequestException(
        'A WhatsApp group URL or null is required.',
      );
    const value = (body as Record<string, unknown>).whatsappGroupUrl;
    const whatsappGroupUrl = safeWhatsappGroupUrl(value);
    if (value !== null && whatsappGroupUrl === null)
      throw new BadRequestException('Invalid WhatsApp group URL.');
    return db.$transaction(async (tx) => {
      const result = await tx.location.updateMany({
        where: { id },
        data: { whatsappGroupUrl },
      });
      if (!result.count) throw new NotFoundException('Location not found.');
      await tx.auditLog.create({
        data: {
          action: 'location.whatsapp_group.updated',
          actor: actor.id,
          target: id,
        },
      });
      return { id, whatsappGroupUrl };
    });
  }

  @Post('admin/locations')
  async createLocation(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = await authenticateAdmin(
      db,
      req,
      ['super_admin', 'exam_manager'],
      true,
    );
    const name = text(body.name);
    const opensAt = optionalInstant(body.opensAt);
    const closesAt = optionalInstant(body.closesAt);
    if (opensAt && closesAt && opensAt >= closesAt)
      throw new BadRequestException('Closing time must be after opening time.');
    for (let i = 0; i < 5; i++) {
      try {
        const location = await db.location.create({
          data: { name, key: randomKey(), opensAt, closesAt },
        });
        await db.auditLog.create({
          data: {
            action: 'location.created',
            actor: actor.id,
            target: location.id,
          },
        });
        return location;
      } catch (error: unknown) {
        if (!(
          typeof error === 'object' &&
          error &&
          'code' in error &&
          error.code === 'P2002'
        ))
          throw error;
      }
    }
    throw new HttpException(
      'Could not generate a unique link. Try again.',
      503,
    );
  }

  @Get('admin/students')
  async students(
    @Req() req: Request,
    @Query('search') search?: string,
    @Query('locationId') locationId?: string,
    @Query('page') pageValue?: string,
  ) {
    await authenticateAdmin(db, req);
    if (
      (search !== undefined &&
        (typeof search !== 'string' || search.length > 120)) ||
      (locationId !== undefined &&
        (typeof locationId !== 'string' || locationId.length > 100)) ||
      (pageValue !== undefined &&
        (typeof pageValue !== 'string' || !/^[1-9]\d{0,5}$/.test(pageValue)))
    ) {
      throw new BadRequestException('Invalid filter.');
    }
    const page = pageValue ? Number(pageValue) : 1;
    const term = search?.trim();
    const where = {
      ...(locationId ? { locationId } : {}),
      ...(term
        ? {
            OR: [
              'name',
              'registrationId',
              'school',
              'district',
              'className',
              'medium',
              'syllabus',
              'locality',
            ].map((field) => ({
              [field]: { contains: term, mode: 'insensitive' as const },
            })),
          }
        : {}),
    };
    const [students, total] = await Promise.all([
      db.student.findMany({
        where,
        select: {
          id: true,
          registrationId: true,
          name: true,
          school: true,
          district: true,
          className: true,
          medium: true,
          syllabus: true,
          locality: true,
          location: { select: { name: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * 50,
        take: 50,
      }),
      db.student.count({ where }),
    ]);
    return { students, total, page };
  }

  @Post('admin/locations/:id/deactivate')
  async deactivate(@Req() req: Request, @Param('id') id: string) {
    const actor = await authenticateAdmin(
      db,
      req,
      ['super_admin', 'exam_manager'],
      true,
    );
    const result = await db.location.updateMany({
      where: { id },
      data: { active: false },
    });
    if (!result.count) throw new NotFoundException();
    await db.auditLog.create({
      data: { action: 'location.deactivated', actor: actor.id, target: id },
    });
    return { ok: true };
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.csrf(req);
    const token = req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('edu_session='))
      ?.slice(12);
    if (token) await db.session.deleteMany({ where: { id: hash(token) } });
    res.clearCookie('edu_session', { path: '/' });
    return { ok: true };
  }
}
