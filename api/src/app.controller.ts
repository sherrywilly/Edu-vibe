import {
  BadRequestException, Body, Controller, Get, Param, Post, Req, Res,
  UnauthorizedException, ForbiddenException, NotFoundException,
  HttpException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';

const db = new PrismaClient();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomKey = () => Array.from({ length: 7 }, () => alphabet[randomInt(alphabet.length)]).join('');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const text = (value: unknown, max = 120) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new BadRequestException('Please check the required fields.');
  return value.trim();
};
const phone = (value: unknown) => {
  const raw = text(value, 30).replace(/[\s()-]/g, '');
  const normal = raw.startsWith('+') ? raw : `+91${raw}`;
  if (!/^\+[1-9]\d{7,14}$/.test(normal)) throw new BadRequestException('Please enter a valid phone number with country code.');
  return normal;
};
const date = (value: unknown) => {
  const raw = text(value, 10);
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (!match) throw new BadRequestException('Enter date of birth as DD/MM/YYYY.');
  const [, day, month, year] = match;
  const iso = `${year}-${month}-${day}`;
  const result = new Date(`${iso}T00:00:00.000Z`);
  if (Number(year) < 1 || !Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== iso) {
    throw new BadRequestException('Enter a valid date of birth.');
  }
  return result;
};
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));

@Controller()
export class AppController {
  private async limit(key: string, max: number, seconds: number) {
    const now = new Date();
    const expires = new Date(now.getTime() + seconds * 1000);
    const rows = await db.$queryRaw<{ count: number }[]>`
      INSERT INTO "RateLimit" ("key", "count", "expiresAt") VALUES (${hash(key)}, 1, ${expires})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "RateLimit"."expiresAt" <= ${now} THEN 1 ELSE "RateLimit"."count" + 1 END,
        "expiresAt" = CASE WHEN "RateLimit"."expiresAt" <= ${now} THEN ${expires} ELSE "RateLimit"."expiresAt" END
      RETURNING "count"`;
    if (rows[0].count > max) throw new HttpException('Too many requests. Please try again later.', 429);
  }

  private csrf(req: Request) {
    if (!process.env.WEB_ORIGIN || req.headers.origin !== process.env.WEB_ORIGIN) throw new ForbiddenException('Invalid request origin.');
  }

  private async session(req: Request, role: string) {
    const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('edu_session='))?.slice(12);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException();
    const session = await db.session.findUnique({ where: { id: hash(token) } });
    if (!session || session.role !== role || session.expiresAt <= new Date()) throw new UnauthorizedException();
    return session;
  }

  private async createSession(res: Response, role: string, studentId?: string) {
    const token = randomBytes(32).toString('hex');
    await db.session.create({ data: { id: hash(token), role, studentId, expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000) } });
    res.cookie('edu_session', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 8 * 60 * 60 * 1000 });
  }

  private async location(key: string) {
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{7}$/.test(key)) throw new NotFoundException('This registration link is invalid.');
    const location = await db.location.findUnique({ where: { key } });
    if (!location) throw new NotFoundException('This registration link is invalid.');
    if (!location.active) throw new ForbiddenException('This registration link is inactive.');
    const now = new Date();
    if (location.opensAt && location.opensAt > now) throw new ForbiddenException('Registration has not opened yet.');
    if (location.closesAt && location.closesAt <= now) throw new ForbiddenException('This registration link has expired.');
    return location;
  }

  @Get('health')
  health() { return { status: 'ok' }; }

  @Get('locations/:key')
  async resolve(@Param('key') key: string, @Req() req: Request) {
    await this.limit(`lookup:${req.ip}`, 100, 60);
    const location = await this.location(key);
    return { name: location.name };
  }

  @Post('register/:key')
  async register(@Param('key') key: string, @Req() req: Request, @Body() body: Record<string, unknown>) {
    this.csrf(req);
    await this.limit(`register:${req.ip}`, 20, 3600);
    const location = await this.location(key);
    if (body.guardianConsent !== true) throw new BadRequestException('Guardian consent is required.');
    const now = new Date();
    const student = await db.student.create({ data: {
      registrationId: `EV-${randomBytes(8).toString('hex').toUpperCase()}`,
      name: text(body.name), dob: date(body.dob), school: text(body.school),
      district: text(body.district), className: text(body.className), medium: text(body.medium),
      syllabus: text(body.syllabus), parentPhone: phone(body.parentPhone),
      whatsappPhone: phone(body.whatsappPhone), locality: text(body.locality),
      guardianConsentAt: now, guardianConsentVersion: '1',
      whatsappConsentAt: body.whatsappConsent === true ? now : null,
      whatsappConsentVersion: body.whatsappConsent === true ? '1' : null,
      locationId: location.id,
    } });
    return { registrationId: student.registrationId };
  }

  @Post('student/login')
  async studentLogin(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: Record<string, unknown>) {
    this.csrf(req);
    await this.limit(`student-login:${req.ip}`, 15, 900);
    let parentPhone: string;
    let dob: Date;
    try { parentPhone = phone(body.phone); dob = date(body.dob); }
    catch { throw new UnauthorizedException('The supplied credentials could not be verified.'); }
    await this.limit(`student-account:${parentPhone}`, 10, 900);
    const matches = await db.student.findMany({ where: { parentPhone, dob }, select: { id: true, registrationId: true } });
    if (matches.length > 1 && !body.registrationId) return { requiresRegistrationId: true };
    const student = matches.length === 1 ? matches[0] : matches.find(s => typeof body.registrationId === 'string' && equal(s.registrationId, body.registrationId.trim()));
    if (!student) throw new UnauthorizedException('The supplied credentials could not be verified.');
    await this.createSession(res, 'student', student.id);
    return { ok: true };
  }

  @Get('student/me')
  async me(@Req() req: Request) {
    const session = await this.session(req, 'student');
    const student = await db.student.findUnique({ where: { id: session.studentId! }, select: { name: true, registrationId: true, school: true, className: true, location: { select: { name: true } } } });
    if (!student) throw new UnauthorizedException();
    return student;
  }

  @Post('admin/login')
  async adminLogin(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: Record<string, unknown>) {
    this.csrf(req);
    await this.limit(`admin-login:${req.ip}`, 10, 900);
    const password = process.env.ADMIN_PASSWORD;
    if (!password || password.length < 20 || typeof body.password !== 'string' || !equal(body.password, password)) throw new UnauthorizedException('The supplied credentials could not be verified.');
    await this.createSession(res, 'admin');
    await db.auditLog.create({ data: { action: 'admin.login', actor: 'bootstrap-admin' } });
    return { ok: true };
  }

  @Get('admin/locations')
  async locations(@Req() req: Request) {
    await this.session(req, 'admin');
    return db.location.findMany({ include: { _count: { select: { students: true } } }, orderBy: { createdAt: 'desc' } });
  }

  @Post('admin/locations')
  async createLocation(@Req() req: Request, @Body() body: Record<string, unknown>) {
    this.csrf(req);
    await this.session(req, 'admin');
    const name = text(body.name);
    for (let i = 0; i < 5; i++) {
      try {
        const location = await db.location.create({ data: { name, key: randomKey() } });
        await db.auditLog.create({ data: { action: 'location.created', actor: 'bootstrap-admin', target: location.id } });
        return location;
      } catch (error: unknown) {
        if (!(typeof error === 'object' && error && 'code' in error && error.code === 'P2002')) throw error;
      }
    }
    throw new HttpException('Could not generate a unique link. Try again.', 503);
  }

  @Post('admin/locations/:id/deactivate')
  async deactivate(@Req() req: Request, @Param('id') id: string) {
    this.csrf(req);
    await this.session(req, 'admin');
    const result = await db.location.updateMany({ where: { id }, data: { active: false } });
    if (!result.count) throw new NotFoundException();
    await db.auditLog.create({ data: { action: 'location.deactivated', actor: 'bootstrap-admin', target: id } });
    return { ok: true };
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.csrf(req);
    const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('edu_session='))?.slice(12);
    if (token) await db.session.deleteMany({ where: { id: hash(token) } });
    res.clearCookie('edu_session', { path: '/' });
    return { ok: true };
  }
}
