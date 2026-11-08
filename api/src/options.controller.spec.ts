import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import * as auth from './auth';
import { OptionsController } from './options.controller';
import { optionsDb, optionsService } from './options.service';

describe('options permissions', () => {
  const controller = new OptionsController();
  const req = { headers: {} } as Request;
  afterEach(() => jest.restoreAllMocks());

  it('allows public listing only with active options', async () => {
    const list = jest.spyOn(optionsService, 'list').mockResolvedValue([]);
    await controller.listPublic();
    expect(list).toHaveBeenCalledWith();
  });

  it('requires an authenticated admin for the management list', async () => {
    const authenticate = jest
      .spyOn(auth, 'authenticateAdmin')
      .mockRejectedValue(new ForbiddenException());
    await expect(controller.listAdmin(req)).rejects.toThrow(ForbiddenException);
    expect(authenticate).toHaveBeenCalledWith(optionsDb, req);
  });

  it('requires manager permissions and CSRF validation for mutations', async () => {
    const authenticate = jest
      .spyOn(auth, 'authenticateAdmin')
      .mockRejectedValue(new ForbiddenException());
    await expect(controller.create(req, {})).rejects.toThrow(
      ForbiddenException,
    );
    await expect(controller.update(req, 'id', {})).rejects.toThrow(
      ForbiddenException,
    );
    expect(authenticate).toHaveBeenCalledWith(
      optionsDb,
      req,
      ['super_admin', 'exam_manager'],
      true,
    );
  });

  it('rejects a reviewer mutation even with a valid session and origin', async () => {
    const previousOrigin = process.env.WEB_ORIGIN;
    process.env.WEB_ORIGIN = 'https://example.test';
    const reviewerRequest = {
      headers: {
        origin: 'https://example.test',
        cookie: `edu_session=${'a'.repeat(64)}`,
      },
    } as Request;
    jest.spyOn(optionsDb.session, 'findUnique').mockResolvedValue({
      id: 'hashed',
      role: 'admin',
      adminId: 'reviewer',
      studentId: null,
      expiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
    });
    jest.spyOn(optionsDb.adminAccount, 'findUnique').mockResolvedValue({
      id: 'reviewer',
      username: 'reviewer',
      role: 'reviewer',
      passwordHash: '',
      createdAt: new Date(),
    });
    const create = jest.spyOn(optionsService, 'create');
    try {
      await expect(
        controller.create(reviewerRequest, { kind: 'school', name: 'Test' }),
      ).rejects.toThrow(ForbiddenException);
      expect(create).not.toHaveBeenCalled();
    } finally {
      if (previousOrigin === undefined) delete process.env.WEB_ORIGIN;
      else process.env.WEB_ORIGIN = previousOrigin;
    }
  });
});
