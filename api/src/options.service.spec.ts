import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { OptionsService } from './options.service';

describe('registration options', () => {
  const rows = [
    { kind: 'school', name: 'Central School' },
    { kind: 'district', name: 'North' },
    { kind: 'className', name: 'Standard 4' },
    { kind: 'medium', name: 'English' },
    { kind: 'syllabus', name: 'State' },
  ];
  const body = {
    school: 'Central School',
    district: 'North',
    className: 'Standard 4',
    medium: 'English',
    syllabus: 'State',
  };
  const findMany = jest.fn();
  const create = jest.fn();
  const updateMany = jest.fn();
  const findUniqueOrThrow = jest.fn();
  const audit = jest.fn();
  const tx = {
    registrationOption: { create, updateMany, findUniqueOrThrow },
    auditLog: { create: audit },
  };
  const db = {
    registrationOption: { findMany },
    $transaction: (fn: (value: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaClient;
  const service = new OptionsService(db);

  beforeEach(() => {
    jest.resetAllMocks();
    findMany.mockResolvedValue(rows);
  });

  it('accepts active selections and requests only active options', async () => {
    await expect(service.validateRegistration(body)).resolves.toEqual(body);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ active: true }),
      }),
    );
  });

  it('accepts and trims an Other school but still checks every other selection', async () => {
    findMany.mockResolvedValue(rows.slice(1));
    await expect(
      service.validateRegistration({
        ...body,
        school: '__other__',
        schoolOther: ' Village School ',
      }),
    ).resolves.toEqual({ ...body, school: 'Village School' });
    expect(findMany.mock.calls[0][0].where.OR).toHaveLength(4);
    findMany.mockResolvedValue(rows.slice(2));
    await expect(
      service.validateRegistration({
        ...body,
        school: '__other__',
        schoolOther: 'Village School',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects unknown, inactive, missing, and malformed selections', async () => {
    findMany.mockResolvedValue(rows.slice(1));
    await expect(service.validateRegistration(body)).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.validateRegistration({
        ...body,
        school: '__other__',
        schoolOther: '  ',
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.validateRegistration({ ...body, district: ['North'] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('creates and audits a valid option', async () => {
    create.mockResolvedValue({ id: 'one', kind: 'medium', name: 'English' });
    await service.create({ kind: 'medium', name: ' English ' }, 'alice');
    expect(create).toHaveBeenCalledWith({
      data: { kind: 'medium', name: 'English' },
    });
    expect(audit).toHaveBeenCalledWith({
      data: { action: 'option.created', actor: 'alice', target: 'one' },
    });
    await expect(
      service.create({ kind: 'unknown', name: 'x' }, 'alice'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create({ kind: 'school', name: '__other__' }, 'alice'),
    ).rejects.toThrow(BadRequestException);
    create.mockRejectedValue({ code: 'P2002' });
    await expect(
      service.create({ kind: 'school', name: 'x' }, 'alice'),
    ).rejects.toThrow(ConflictException);
  });

  it('updates and audits options, rejecting missing IDs and invalid state', async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findUniqueOrThrow.mockResolvedValue({ id: 'one', active: false });
    await service.update('one', { active: false }, 'alice');
    expect(audit).toHaveBeenCalledWith({
      data: { action: 'option.updated', actor: 'alice', target: 'one' },
    });
    await expect(
      service.update('one', { active: 'false' }, 'alice'),
    ).rejects.toThrow(BadRequestException);
    updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.update('missing', { active: false }, 'alice'),
    ).rejects.toThrow(NotFoundException);
  });
});
