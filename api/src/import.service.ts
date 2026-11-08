import {
  BadRequestException,
  ConflictException,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';

const columns = [
  'name',
  'dob',
  'school',
  'district',
  'className',
  'medium',
  'syllabus',
  'parentPhone',
  'whatsappPhone',
  'locality',
  'guardianConsentAt',
  'guardianConsentVersion',
  'whatsappConsentAt',
  'whatsappConsentVersion',
] as const;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
type Input = { locationId: string; csv: string };
type Student = Omit<
  Prisma.StudentUncheckedCreateInput,
  'registrationId' | 'locationId'
>;
type Row = {
  row: number;
  name: string;
  errors: string[];
  duplicate: boolean;
  data?: Student;
};

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false,
    closed = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === '"') {
      if (field || closed)
        throw new BadRequestException('Malformed CSV quoting.');
      quoted = true;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(field);
      field = '';
      closed = false;
      if (c !== ',') {
        if (c === '\r' && csv[i + 1] === '\n') i++;
        rows.push(row);
        row = [];
      }
    } else {
      if (closed) throw new BadRequestException('Malformed CSV quoting.');
      field += c;
    }
  }
  if (quoted) throw new BadRequestException('Unclosed CSV quote.');
  if (field || row.length || closed) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function instant(value: string): Date | null {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    return null;
  const date = new Date(value);
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    Number.isFinite(day.getTime()) &&
    day.toISOString().slice(0, 10) === value.slice(0, 10) &&
    date <= new Date()
    ? date
    : null;
}

function phone(value: string): string | null {
  const raw = value.replace(/[\s()-]/g, '');
  const normalized = raw.startsWith('+') ? raw : `+91${raw}`;
  return value.length <= 30 && /^\+[1-9]\d{7,14}$/.test(normalized)
    ? normalized
    : null;
}

export function parseImport(input: unknown): {
  input: Input;
  rows: Row[];
  digest: string;
} {
  if (!input || typeof input !== 'object')
    throw new BadRequestException('CSV and location are required.');
  const { locationId, csv } = input as Record<string, unknown>;
  if (
    typeof locationId !== 'string' ||
    !locationId.trim() ||
    locationId.length > 100 ||
    typeof csv !== 'string' ||
    Buffer.byteLength(csv, 'utf8') > 65536
  ) {
    throw new BadRequestException(
      'Provide a location and a CSV of at most 64 KiB.',
    );
  }
  const records = parseCsv(csv.replace(/^\uFEFF/, ''));
  if (
    !records.length ||
    records[0].length !== columns.length ||
    records[0].some((v, i) => v.trim() !== columns[i])
  ) {
    throw new BadRequestException(`CSV header must be: ${columns.join(',')}`);
  }
  if (records.length < 2 || records.length > 201)
    throw new BadRequestException('CSV must contain 1–200 data rows.');
  const rows = records.slice(1).map((cells, index): Row => {
    const errors: string[] = [];
    if (cells.length !== columns.length)
      return {
        row: index + 2,
        name: '',
        errors: ['Incorrect number of columns.'],
        duplicate: false,
      };
    const v = Object.fromEntries(
      columns.map((key, i) => [key, cells[i].trim()]),
    ) as Record<(typeof columns)[number], string>;
    for (const key of [
      'name',
      'school',
      'district',
      'className',
      'medium',
      'syllabus',
      'locality',
    ] as const) {
      if (!v[key] || v[key].length > 120)
        errors.push(`${key} is required (maximum 120 characters).`);
    }
    const dobMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.dob);
    const dobIso = dobMatch
      ? `${dobMatch[3]}-${dobMatch[2]}-${dobMatch[1]}`
      : '';
    const dob = new Date(`${dobIso}T00:00:00Z`);
    if (
      !dobMatch ||
      Number(dobMatch[3]) < 1 ||
      !Number.isFinite(dob.getTime()) ||
      dob.toISOString().slice(0, 10) !== dobIso ||
      dob > new Date()
    )
      errors.push('dob must be a valid past date in DD/MM/YYYY format.');
    const parentPhone = phone(v.parentPhone),
      whatsappPhone = phone(v.whatsappPhone);
    if (!parentPhone) errors.push('parentPhone is invalid.');
    if (!whatsappPhone) errors.push('whatsappPhone is invalid.');
    const guardianConsentAt = instant(v.guardianConsentAt);
    if (
      !guardianConsentAt ||
      !v.guardianConsentVersion ||
      v.guardianConsentVersion.length > 120
    )
      errors.push(
        'Recorded guardian consent timestamp and version are required.',
      );
    const whatsappConsentAt = v.whatsappConsentAt
      ? instant(v.whatsappConsentAt)
      : null;
    if (
      !!v.whatsappConsentAt !== !!v.whatsappConsentVersion ||
      (v.whatsappConsentAt && !whatsappConsentAt) ||
      v.whatsappConsentVersion.length > 120
    )
      errors.push(
        'WhatsApp consent timestamp and version must both be valid or both be empty.',
      );
    return {
      row: index + 2,
      name: v.name,
      errors,
      duplicate: false,
      ...(errors.length
        ? {}
        : {
            data: {
              name: v.name,
              dob,
              school: v.school,
              district: v.district,
              className: v.className,
              medium: v.medium,
              syllabus: v.syllabus,
              parentPhone: parentPhone!,
              whatsappPhone: whatsappPhone!,
              locality: v.locality,
              guardianConsentAt: guardianConsentAt!,
              guardianConsentVersion: v.guardianConsentVersion,
              whatsappConsentAt,
              whatsappConsentVersion: v.whatsappConsentVersion || null,
            },
          }),
    };
  });
  return {
    input: { locationId, csv },
    rows,
    digest: hash(JSON.stringify([locationId, csv])),
  };
}

@Injectable()
export class ImportService implements OnModuleDestroy {
  private readonly db = new PrismaClient();
  async onModuleDestroy() {
    await this.db.$disconnect();
  }

  private async validate(
    db: Prisma.TransactionClient,
    parsed: ReturnType<typeof parseImport>,
  ) {
    const location = await db.location.findUnique({
      where: { id: parsed.input.locationId },
      select: { id: true },
    });
    if (!location) throw new BadRequestException('Location not found.');
    const valid = parsed.rows.filter((row) => row.data);
    const existing = valid.length
      ? await db.student.findMany({
          where: {
            OR: valid.map((row) => ({
              parentPhone: row.data!.parentPhone,
              dob: row.data!.dob,
            })),
          },
          select: { parentPhone: true, dob: true },
        })
      : [];
    const key = (phone: string, dob: Date | string) =>
      `${phone}:${new Date(dob).toISOString().slice(0, 10)}`;
    const existingKeys = new Set(
      existing.map((item) => key(item.parentPhone, item.dob)),
    );
    const counts = new Map<string, number>();
    for (const row of valid) {
      const k = key(row.data!.parentPhone, row.data!.dob);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    for (const row of valid) {
      const k = key(row.data!.parentPhone, row.data!.dob);
      row.duplicate = existingKeys.has(k) || counts.get(k)! > 1;
    }
    return {
      digest: parsed.digest,
      rows: parsed.rows.map(({ row, name, errors, duplicate }) => ({
        row,
        name,
        errors,
        duplicate,
      })),
      valid: parsed.rows.every((row) => !row.errors.length && !row.duplicate),
    };
  }

  async preview(input: unknown) {
    const parsed = parseImport(input);
    return this.validate(this.db, parsed);
  }

  async confirm(input: unknown, actor: string) {
    if (!input || typeof input !== 'object')
      throw new BadRequestException('Invalid request.');
    const { idempotencyKey, digest } = input as Record<string, unknown>;
    if (
      typeof idempotencyKey !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,128}$/.test(idempotencyKey) ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      throw new BadRequestException(
        'A valid idempotency key and preview digest are required.',
      );
    const parsed = parseImport(input);
    if (parsed.digest !== digest)
      throw new ConflictException('CSV or location changed since preview.');
    const prefix = `v1:${hash(idempotencyKey)}:`;
    return this.db.$transaction(
      async (tx) => {
        // Serializes imports across keys so duplicate checks cannot race each other.
        await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(1162105933, 1)) AS import_lock`;
        const previous = await tx.auditLog.findFirst({
          where: {
            action: 'student.import',
            actor,
            target: { startsWith: prefix },
          },
          select: { target: true },
        });
        if (previous?.target) {
          const [, , priorDigest, count] = previous.target.split(':');
          if (priorDigest !== digest)
            throw new ConflictException(
              'Idempotency key was already used for different content.',
            );
          return { imported: Number(count), replayed: true };
        }
        const result = await this.validate(tx, parsed);
        if (!result.valid)
          throw new ConflictException(
            'Import contains invalid or potentially duplicate rows. Preview again.',
          );
        await tx.student.createMany({
          data: parsed.rows.map((row) => ({
            ...row.data!,
            locationId: parsed.input.locationId,
            registrationId: `EV-${randomBytes(8).toString('hex').toUpperCase()}`,
          })),
        });
        await tx.auditLog.create({
          data: {
            action: 'student.import',
            actor,
            target: `${prefix}${digest}:${parsed.rows.length}`,
          },
        });
        return { imported: parsed.rows.length, replayed: false };
      },
      { timeout: 30000 },
    );
  }
}
