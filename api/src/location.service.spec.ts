import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { authenticateAdmin } from './auth';
import { LocationController } from './location.controller';
import { LocationService } from './location.service';

jest.mock('./auth', () => ({ authenticateAdmin: jest.fn() }));

describe('location window management', () => {
  const before = {
    opensAt: new Date('2026-01-01T10:00:00Z'),
    closesAt: new Date('2026-01-02T10:00:00Z'),
  };
  const expected = {
    opensAt: before.opensAt.toISOString(),
    closesAt: before.closesAt.toISOString(),
  };
  const input = {
    opensAt: '2026-02-01T10:00:00Z',
    closesAt: '2026-02-02T10:00:00Z',
    expected,
  };
  let service: LocationService;
  let tx: {
    location: { findUnique: jest.Mock; updateMany: jest.Mock };
    auditLog: { create: jest.Mock };
  };
  let db: {
    $transaction: jest.Mock;
    location: { findUnique: jest.Mock };
    auditLog: { findMany: jest.Mock };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    tx = {
      location: {
        findUnique: jest.fn().mockResolvedValue({ id: 'loc', ...before }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    db = {
      $transaction: jest.fn(async (fn: (transaction: typeof tx) => unknown) =>
        fn(tx),
      ),
      location: { findUnique: jest.fn().mockResolvedValue({ id: 'loc' }) },
      auditLog: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new LocationService();
    Object.defineProperty(service, 'db', { value: db });
  });

  it('updates both boundaries and records old and new values and the authenticated actor atomically', async () => {
    await expect(
      service.updateWindow('loc', input, 'user-1'),
    ).resolves.toMatchObject({ id: 'loc', opensAt: new Date(input.opensAt) });
    expect(tx.location.updateMany).toHaveBeenCalledWith({
      where: { id: 'loc', ...before },
      data: {
        opensAt: new Date(input.opensAt),
        closesAt: new Date(input.closesAt),
      },
    });
    const audit = tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ actor: 'user-1', target: 'loc' });
    expect(
      JSON.parse((audit.action as string).split('location.window.updated:')[1]),
    ).toEqual({
      before: expected,
      after: {
        opensAt: input.opensAt.replace('Z', '.000Z'),
        closesAt: input.closesAt.replace('Z', '.000Z'),
      },
    });
    tx.auditLog.create.mockRejectedValueOnce(new Error('audit failed'));
    await expect(service.updateWindow('loc', input, 'user-1')).rejects.toThrow(
      'audit failed',
    );
  });

  it('accepts clearing boundaries and rejects malformed, impossible or unordered timestamps', async () => {
    await expect(
      service.updateWindow(
        'loc',
        { opensAt: null, closesAt: null, expected },
        'user-1',
      ),
    ).resolves.toMatchObject({ opensAt: null, closesAt: null });
    for (const opensAt of [
      '',
      '2026-02-30T10:00:00Z',
      '2026-01-01T10:00:00',
      '2026-01-01',
      123,
      undefined,
    ]) {
      await expect(
        service.updateWindow('loc', { ...input, opensAt }, 'user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      service.updateWindow(
        'loc',
        { ...input, closesAt: input.opensAt },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updateWindow('loc', { ...input, expected: undefined }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects missing and stale locations without an audit entry', async () => {
    tx.location.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.updateWindow('loc', input, 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.updateWindow(
        'loc',
        { ...input, expected: { opensAt: null, closesAt: null } },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    tx.location.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.updateWindow('loc', input, 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('returns decoded location history and ignores events for other targets', async () => {
    db.auditLog.findMany.mockResolvedValueOnce([
      {
        id: 'log',
        action: `location.window.updated:${JSON.stringify({ before: expected, after: expected })}`,
        actor: 'user-1',
        createdAt: new Date(),
      },
      {
        id: 'old',
        action: 'location.created',
        actor: 'bootstrap-admin',
        createdAt: new Date(),
      },
    ]);
    const history = await service.history('loc');
    expect(db.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ target: 'loc' }),
        take: 100,
      }),
    );
    expect(history[0]).toMatchObject({
      action: 'location.window.updated',
      details: { before: expected },
    });
    expect(history[1]).toMatchObject({
      action: 'location.created',
      details: null,
    });
    db.location.findUnique.mockResolvedValueOnce(null);
    await expect(service.history('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('requires an authenticated manager with origin checking for edits and authenticated admin for history', async () => {
    const controller = new LocationController(service);
    const req = { headers: {} } as Request;
    const auth = jest.mocked(authenticateAdmin);
    auth
      .mockRejectedValueOnce(new UnauthorizedException())
      .mockRejectedValueOnce(new ForbiddenException());
    await expect(
      controller.updateWindow(req, 'loc', input),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      controller.updateWindow(req, 'loc', input),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.location.updateMany).not.toHaveBeenCalled();
    auth.mockResolvedValue({
      id: 'user-1',
      username: 'manager',
      role: 'exam_manager',
    });
    await controller.updateWindow(req, 'loc', input);
    expect(auth).toHaveBeenLastCalledWith(
      db,
      req,
      ['super_admin', 'exam_manager'],
      true,
    );
    await controller.history(req, 'loc');
    expect(auth).toHaveBeenLastCalledWith(db, req);
  });
});
