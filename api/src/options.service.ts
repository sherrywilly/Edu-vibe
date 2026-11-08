import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

export const optionKinds = [
  'school',
  'district',
  'className',
  'medium',
  'syllabus',
] as const;
export type OptionKind = (typeof optionKinds)[number];
export const optionsDb = new PrismaClient();

function optionKind(value: unknown): OptionKind {
  if (typeof value !== 'string' || !optionKinds.includes(value as OptionKind))
    throw new BadRequestException('Invalid option type.');
  return value as OptionKind;
}

function optionName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 120 ||
    value.trim().toLowerCase() === '__other__'
  ) {
    throw new BadRequestException(
      'Enter a valid option name (up to 120 characters).',
    );
  }
  return value.trim();
}

export class OptionsService {
  constructor(private readonly db: PrismaClient) {}

  async list(activeOnly = true) {
    const items = await this.db.registrationOption.findMany({
      where: activeOnly ? { active: true } : {},
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });
    return items;
  }

  async validateRegistration(body: Record<string, unknown>) {
    if (!body || typeof body !== 'object')
      throw new BadRequestException('Please check the required fields.');
    const values = {
      school:
        body.school === '__other__'
          ? optionName(body.schoolOther)
          : optionName(body.school),
      district: optionName(body.district),
      className: optionName(body.className),
      medium: optionName(body.medium),
      syllabus: optionName(body.syllabus),
    };
    const expected = optionKinds.filter(
      (kind) => kind !== 'school' || body.school !== '__other__',
    );
    const options = await this.db.registrationOption.findMany({
      where: {
        active: true,
        OR: expected.map((kind) => ({ kind, name: values[kind] })),
      },
      select: { kind: true, name: true },
    });
    if (
      expected.some(
        (kind) =>
          !options.some(
            (item) => item.kind === kind && item.name === values[kind],
          ),
      )
    ) {
      throw new BadRequestException(
        'Please select a currently available registration option.',
      );
    }
    return values;
  }

  async create(body: Record<string, unknown>, actor: string) {
    const kind = optionKind(body?.kind);
    const name = optionName(body?.name);
    try {
      return await this.db.$transaction(async (tx) => {
        const option = await tx.registrationOption.create({
          data: { kind, name },
        });
        await tx.auditLog.create({
          data: { actor, action: 'option.created', target: option.id },
        });
        return option;
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error &&
        'code' in error &&
        error.code === 'P2002'
      )
        throw new ConflictException('This option already exists.');
      throw error;
    }
  }

  async update(id: string, body: Record<string, unknown>, actor: string) {
    if (typeof id !== 'string' || !id || id.length > 100)
      throw new BadRequestException('Invalid option.');
    if (
      !body ||
      typeof body !== 'object' ||
      (body.name === undefined && body.active === undefined)
    )
      throw new BadRequestException('No changes supplied.');
    const name = body.name === undefined ? undefined : optionName(body.name);
    if (body.active !== undefined && typeof body.active !== 'boolean')
      throw new BadRequestException('Invalid option status.');
    const active = body.active;
    try {
      return await this.db.$transaction(async (tx) => {
        const result = await tx.registrationOption.updateMany({
          where: { id },
          data: { name, active },
        });
        if (!result.count) throw new NotFoundException('Option not found.');
        const option = await tx.registrationOption.findUniqueOrThrow({
          where: { id },
        });
        await tx.auditLog.create({
          data: { actor, action: 'option.updated', target: id },
        });
        return option;
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error &&
        'code' in error &&
        error.code === 'P2002'
      )
        throw new ConflictException('This option already exists.');
      throw error;
    }
  }
}

export const optionsService = new OptionsService(optionsDb);
export const validateRegistrationOptions = (body: Record<string, unknown>) =>
  optionsService.validateRegistration(body);
