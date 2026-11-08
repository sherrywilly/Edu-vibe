import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';

describe('import authorization', () => {
  const token = 'a'.repeat(64);
  const req = {
    headers: {
      cookie: `edu_session=${token}`,
      origin: 'https://school.example',
    },
  } as Request;
  const imports = {
    preview: jest.fn().mockResolvedValue({ valid: true }),
    confirm: jest.fn().mockResolvedValue({ imported: 1 }),
  };
  const db = {
    session: { findUnique: jest.fn() },
    adminAccount: { findUnique: jest.fn() },
  };
  const controller = new ImportController(imports as unknown as ImportService);

  beforeEach(() => {
    process.env.WEB_ORIGIN = 'https://school.example';
    Object.assign(controller, { authDb: db });
    jest.clearAllMocks();
    db.session.findUnique.mockResolvedValue({
      role: 'admin',
      adminId: 'admin',
      expiresAt: new Date(Date.now() + 60000),
    });
    db.adminAccount.findUnique.mockResolvedValue({
      id: 'admin',
      username: 'admin',
      role: 'super_admin',
    });
  });

  it('only allows a super administrator with a valid origin', async () => {
    await controller.preview(req, {});
    await controller.confirm(req, {});
    expect(imports.confirm).toHaveBeenCalledWith({}, 'admin');
    db.adminAccount.findUnique.mockResolvedValue({
      id: 'admin',
      role: 'reviewer',
    });
    await expect(controller.preview(req, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(controller.confirm(req, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      controller.preview(
        {
          headers: { ...req.headers, origin: 'https://evil.example' },
        } as Request,
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    db.session.findUnique.mockResolvedValue(null);
    await expect(controller.confirm(req, {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
