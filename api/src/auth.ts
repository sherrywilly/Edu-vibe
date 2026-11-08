import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'crypto';
import { promisify } from 'util';
import type { Request } from 'express';

const scrypt = promisify(scryptCallback);
export const adminRoles = ['super_admin', 'exam_manager', 'reviewer'] as const;
export type AdminRole = (typeof adminRoles)[number];
export const sessionHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export const sessionToken = (req: Request) => {
  const token = req.headers.cookie
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith('edu_session='))
    ?.slice(12);
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new UnauthorizedException();
  return token;
};

export function usernameValue(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(value)
  ) {
    throw new BadRequestException(
      'Username must be 3–64 letters, numbers, dots, underscores or hyphens.',
    );
  }
  return value.toLowerCase();
}

export function passwordValue(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 12 ||
    Buffer.byteLength(value, 'utf8') > 1024
  ) {
    throw new BadRequestException(
      'Password must be at least 12 characters and at most 1024 bytes.',
    );
  }
  return value;
}

export function roleValue(value: unknown): AdminRole {
  if (typeof value !== 'string' || !adminRoles.includes(value as AdminRole))
    throw new BadRequestException('Invalid admin role.');
  return value as AdminRole;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  if (!match || Buffer.byteLength(password, 'utf8') > 1024) return false;
  const derived = (await scrypt(
    password,
    Buffer.from(match[1], 'hex'),
    64,
  )) as Buffer;
  return timingSafeEqual(derived, Buffer.from(match[2], 'hex'));
}

export async function authenticateAdmin(
  db: PrismaClient,
  req: Request,
  roles: readonly AdminRole[] = adminRoles,
  mutation = false,
) {
  if (
    mutation &&
    (!process.env.WEB_ORIGIN || req.headers.origin !== process.env.WEB_ORIGIN)
  ) {
    throw new ForbiddenException('Invalid request origin.');
  }
  const session = await db.session.findUnique({
    where: { id: sessionHash(sessionToken(req)) },
  });
  if (
    !session ||
    session.role !== 'admin' ||
    !session.adminId ||
    session.expiresAt <= new Date()
  )
    throw new UnauthorizedException();
  const admin = await db.adminAccount.findUnique({
    where: { id: session.adminId },
    select: { id: true, username: true, role: true },
  });
  if (!admin || !adminRoles.includes(admin.role as AdminRole))
    throw new UnauthorizedException();
  if (!roles.includes(admin.role as AdminRole)) throw new ForbiddenException();
  return admin;
}
