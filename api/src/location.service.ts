import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

const windowAction = 'location.window.updated:';
type Window = { opensAt: Date | null; closesAt: Date | null };

function instant(value: unknown): Date | null {
  if (value === null) return null;
  if (typeof value !== 'string')
    throw new BadRequestException(
      'Times must be ISO timestamps with a timezone, or null.',
    );
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match)
    throw new BadRequestException(
      'Times must be ISO timestamps with a timezone, or null.',
    );
  const [, y, m, d, h, min, s, zone] = match;
  const year = Number(y),
    month = Number(m),
    day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    Number(h) > 23 ||
    Number(min) > 59 ||
    Number(s) > 59 ||
    (zone !== 'Z' &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))
  ) {
    throw new BadRequestException('Invalid timestamp.');
  }
  const result = new Date(value);
  if (!Number.isFinite(result.getTime()))
    throw new BadRequestException('Invalid timestamp.');
  return result;
}

function parseWindow(body: unknown): Window {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestException('Both window fields are required.');
  const data = body as Record<string, unknown>;
  if (
    !Object.hasOwn(data, 'opensAt') ||
    !Object.hasOwn(data, 'closesAt') ||
    Object.keys(data).some((key) => key !== 'opensAt' && key !== 'closesAt')
  ) {
    throw new BadRequestException('Both window fields are required.');
  }
  const opensAt = instant(data.opensAt),
    closesAt = instant(data.closesAt);
  if (opensAt && closesAt && opensAt >= closesAt)
    throw new BadRequestException('Closing time must be after opening time.');
  return { opensAt, closesAt };
}

@Injectable()
export class LocationService implements OnModuleDestroy {
  private readonly db = new PrismaClient();

  get database() {
    return this.db;
  }

  async onModuleDestroy() {
    await this.db.$disconnect();
  }

  async updateWindow(id: string, body: unknown, actorId: string) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Window and expected values are required.');
    const data = body as Record<string, unknown>;
    if (
      Object.keys(data).some(
        (key) => !['opensAt', 'closesAt', 'expected'].includes(key),
      )
    )
      throw new BadRequestException('Invalid window fields.');
    const window = parseWindow({
      opensAt: data.opensAt,
      closesAt: data.closesAt,
    });
    const expected = parseWindow(data.expected);
    return this.db.$transaction(async (tx) => {
      const current = await tx.location.findUnique({
        where: { id },
        select: { id: true, opensAt: true, closesAt: true },
      });
      if (!current) throw new NotFoundException('Location not found.');
      if (
        current.opensAt?.getTime() !== expected.opensAt?.getTime() ||
        current.closesAt?.getTime() !== expected.closesAt?.getTime()
      ) {
        throw new ConflictException(
          'The window changed. Reload and try again.',
        );
      }
      const changed = await tx.location.updateMany({
        where: { id, opensAt: current.opensAt, closesAt: current.closesAt },
        data: window,
      });
      if (!changed.count)
        throw new ConflictException(
          'The window changed. Reload and try again.',
        );
      await tx.auditLog.create({
        data: {
          action:
            windowAction +
            JSON.stringify({
              before: { opensAt: current.opensAt, closesAt: current.closesAt },
              after: window,
            }),
          actor: actorId,
          target: id,
        },
      });
      return { id, ...window };
    });
  }

  async history(id: string) {
    const location = await this.db.location.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!location) throw new NotFoundException('Location not found.');
    const entries = await this.db.auditLog.findMany({
      where: {
        target: id,
        OR: [
          { action: { startsWith: windowAction } },
          { action: { in: ['location.created', 'location.deactivated'] } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: { id: true, action: true, actor: true, createdAt: true },
    });
    return entries.map((entry) => {
      if (!entry.action.startsWith(windowAction))
        return { ...entry, details: null };
      try {
        const details: unknown = JSON.parse(
          entry.action.slice(windowAction.length),
        );
        return { ...entry, action: 'location.window.updated', details };
      } catch {
        return { ...entry, action: 'location.window.updated', details: null };
      }
    });
  }
}
