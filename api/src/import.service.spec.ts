import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { ImportService, parseImport } from './import.service';

const header =
  'name,dob,school,district,className,medium,syllabus,parentPhone,whatsappPhone,locality,guardianConsentAt,guardianConsentVersion,whatsappConsentAt,whatsappConsentVersion';
const row =
  '"Doe, Jane",01/02/2010,School,District,5,English,Board,9876543210,9876543210,Town,2024-01-01T10:00:00Z,v1,,';
const input = { locationId: 'location', csv: `${header}\r\n${row}\r\n` };

describe('student imports', () => {
  it('parses quoted CSV and preserves explicit consent without inferring WhatsApp consent', () => {
    const parsed = parseImport(input);
    expect(parsed.rows[0]).toMatchObject({
      name: 'Doe, Jane',
      errors: [],
      data: {
        guardianConsentAt: new Date('2024-01-01T10:00:00Z'),
        guardianConsentVersion: 'v1',
        whatsappConsentAt: null,
        whatsappConsentVersion: null,
        parentPhone: '+919876543210',
      },
    });
  });

  const integration = process.env.IMPORT_TEST_DATABASE_URL
    ? describe
    : describe.skip;
  integration('student import transactions (PostgreSQL)', () => {
    let db: PrismaClient;
    let service: ImportService;
    const locationId = randomUUID();
    const actor = randomUUID();
    const key = randomUUID();

    beforeAll(async () => {
      process.env.DATABASE_URL = process.env.IMPORT_TEST_DATABASE_URL;
      db = new PrismaClient();
      service = new ImportService();
      await db.location.create({
        data: {
          id: locationId,
          name: 'Import test',
          key: randomBytes(3).toString('hex').toUpperCase(),
        },
      });
    });
    afterAll(async () => {
      await db.auditLog.deleteMany({
        where: { action: 'student.import', actor },
      });
      await db.student.deleteMany({ where: { locationId } });
      await db.location.deleteMany({ where: { id: locationId } });
      await service.onModuleDestroy();
      await db.$disconnect();
    });

    it('serializes simultaneous confirmations and persists the idempotency result', async () => {
      const data = { ...input, locationId };
      const request = {
        ...data,
        digest: parseImport(data).digest,
        idempotencyKey: key,
      };
      const results = await Promise.all([
        service.confirm(request, actor),
        service.confirm(request, actor),
      ]);
      expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
      expect(await db.student.count({ where: { locationId } })).toBe(1);
      expect(
        await db.auditLog.count({ where: { action: 'student.import', actor } }),
      ).toBe(1);
      const duplicate = {
        ...data,
        csv: data.csv.replace('Doe, Jane', 'Another person'),
      };
      await expect(
        service.confirm(
          {
            ...duplicate,
            digest: parseImport(duplicate).digest,
            idempotencyKey: randomUUID(),
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await db.student.count({ where: { locationId } })).toBe(1);
    });
  });

  it('rejects malformed, oversized and incorrect CSV', () => {
    expect(() =>
      parseImport({ ...input, csv: `${header}\n"unclosed` }),
    ).toThrow(BadRequestException);
    expect(() => parseImport({ ...input, csv: 'name,dob\nx,y' })).toThrow(
      BadRequestException,
    );
    expect(() => parseImport({ ...input, csv: 'a'.repeat(65537) })).toThrow(
      BadRequestException,
    );
    expect(() =>
      parseImport({
        ...input,
        csv: `${header}\n${Array(201).fill(row).join('\n')}`,
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects invalid dates and missing or partial consent evidence', () => {
    const invalid = row
      .replace('01/02/2010', '31/02/2010')
      .replace('2024-01-01T10:00:00Z,v1,,', ',,2024-01-01T10:00:00Z,');
    const parsed = parseImport({ ...input, csv: `${header}\n${invalid}` });
    expect(parsed.rows[0].errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('dob'),
        expect.stringContaining('guardian consent'),
        expect.stringContaining('WhatsApp consent'),
      ]),
    );
    expect(parsed.rows[0].data).toBeUndefined();
  });

  it('flags duplicates inside a file and in existing records', async () => {
    const service = new ImportService();
    const db = {
      location: { findUnique: jest.fn().mockResolvedValue({ id: 'location' }) },
      student: { findMany: jest.fn().mockResolvedValue([]) },
    };
    Object.assign(service, { db });
    const result = await service.preview({
      ...input,
      csv: `${header}\n${row}\n${row}`,
    });
    expect(result.valid).toBe(false);
    expect(result.rows.map((r) => r.duplicate)).toEqual([true, true]);
    db.student.findMany.mockResolvedValue([
      { parentPhone: '+919876543210', dob: new Date('2010-02-01') },
    ]);
    expect((await service.preview(input)).rows[0].duplicate).toBe(true);
  });

  it('replays a successful key and rejects changed payloads, before duplicate validation', async () => {
    const service = new ImportService();
    let target: string | null = null;
    const tx = {
      $queryRaw: jest.fn(),
      location: { findUnique: jest.fn().mockResolvedValue({ id: 'location' }) },
      student: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn(),
      },
      auditLog: {
        findFirst: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(target ? { target } : null),
          ),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: { target: string } }) => {
            target = data.target;
          }),
      },
    };
    Object.assign(service, {
      db: { $transaction: (fn: (tx: unknown) => unknown) => fn(tx) },
    });
    const digest = parseImport(input).digest;
    const request = {
      ...input,
      digest,
      idempotencyKey: 'example-key-123456789',
    };
    await expect(service.confirm(request, 'admin')).resolves.toEqual({
      imported: 1,
      replayed: false,
    });
    await expect(service.confirm(request, 'admin')).resolves.toEqual({
      imported: 1,
      replayed: true,
    });
    expect(tx.student.createMany).toHaveBeenCalledTimes(1);
    const changed = { ...input, csv: input.csv.replace('School', 'Other') };
    await expect(
      service.confirm(
        {
          ...changed,
          digest: parseImport(changed).digest,
          idempotencyKey: request.idempotencyKey,
        },
        'admin',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.confirm(
        { ...changed, digest, idempotencyKey: request.idempotencyKey },
        'admin',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
