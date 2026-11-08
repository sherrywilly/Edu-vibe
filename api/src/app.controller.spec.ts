import { AppController } from './app.controller';
import { PrismaClient } from '@prisma/client';
import { hashPassword, verifyPassword } from './auth';

jest.mock('@prisma/client', () => {
  const instance = {
    $queryRaw: jest.fn().mockResolvedValue([{ count: 1 }]),
    location: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    student: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
    },
    registrationOption: { findMany: jest.fn() },
    session: {
      create: jest.fn(),
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
    },
    adminAccount: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  instance.$transaction.mockImplementation((callback) => callback(instance));
  return { PrismaClient: jest.fn(() => instance) };
});

describe('registration and student authentication', () => {
  const db = new PrismaClient();
  const controller = new AppController();
  const req = {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'http://localhost:3000' },
  } as never;
  const res = { cookie: jest.fn(), clearCookie: jest.fn() } as never;

  beforeEach(() => {
    process.env.WEB_ORIGIN = 'http://localhost:3000';
    process.env.RATE_LIMIT_SECRET = 'test-secret-with-more-than-32-characters';
    process.env.RATE_LIMIT_IP_MODE = 'direct';
    jest.clearAllMocks();
    (db.$queryRaw as jest.Mock).mockResolvedValue([{ count: 1 }]);
    (db.adminAccount.findUnique as jest.Mock).mockResolvedValue({
      id: 'admin-1',
      username: 'admin',
      role: 'super_admin',
    });

    (db.registrationOption.findMany as jest.Mock).mockImplementation(
      ({ where }) =>
        Promise.resolve(
          where.OR.map((item: { kind: string; name: string }) => item),
        ),
    );
  });

  it('limits lookup and registration per key when network identity is disabled', async () => {
    delete process.env.RATE_LIMIT_IP_MODE;
    (db.$queryRaw as jest.Mock).mockResolvedValue([{ count: 301 }]);
    await expect(controller.resolve('ABCDEFG', req)).rejects.toThrow(
      'Too many requests',
    );
    await expect(controller.register('ABCDEFG', req, {})).rejects.toThrow(
      'Too many requests',
    );
    expect(db.location.findUnique).not.toHaveBeenCalled();
  });

  it('resolves only active links within their window', async () => {
    const find = db.location.findUnique as jest.Mock;
    find
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ active: false })
      .mockResolvedValueOnce({ active: true, closesAt: new Date(0) })
      .mockResolvedValueOnce({ name: 'North', active: true });
    await expect(controller.resolve('ABCDEFG', req)).rejects.toThrow('invalid');
    await expect(controller.resolve('ABCDEFG', req)).rejects.toThrow(
      'inactive',
    );
    await expect(controller.resolve('ABCDEFG', req)).rejects.toThrow('expired');
    await expect(controller.resolve('ABCDEFG', req)).resolves.toEqual({
      name: 'North',
    });
  });

  it('assigns the server-resolved location and keeps phone numbers separate', async () => {
    (db.location.findUnique as jest.Mock).mockResolvedValue({
      id: 'real-location',
      name: 'North',
      whatsappGroupUrl: 'https://chat.whatsapp.com/RealGroup123?mode=ac_t',
      active: true,
    });
    (db.student.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({
        ...data,
        location: {
          name: 'North',
          whatsappGroupUrl: 'https://chat.whatsapp.com/RealGroup123?mode=ac_t',
        },
      }),
    );
    const result = await controller.register('ABCDEFG', req, {
      name: 'Student',
      dob: '29/02/2020',
      school: 'School',
      district: 'District',
      className: 'Standard 4',
      medium: 'English',
      syllabus: 'Board',
      parentPhone: '9876543210',
      whatsappPhone: '+919876543211',
      locality: 'Village',
      guardianConsent: true,
      locationId: 'forged',
      location: {
        name: 'Forged',
        whatsappGroupUrl: 'https://chat.whatsapp.com/Forged',
      },
      whatsappGroupUrl: 'https://chat.whatsapp.com/Forged',
    });

    expect(result).toEqual({
      registrationId: expect.any(String),
      location: {
        name: 'North',
        whatsappGroupUrl: 'https://chat.whatsapp.com/RealGroup123?mode=ac_t',
      },
    });
    expect(db.student.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          locationId: 'real-location',
          parentPhone: '+919876543210',
          whatsappPhone: '+919876543211',
          whatsappConsentAt: null,
        }),
      }),
    );
  });

  it('rejects inactive options and accepts a separately entered other school', async () => {
    (db.location.findUnique as jest.Mock).mockResolvedValue({
      id: 'real-location',
      active: true,
    });
    (db.student.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({
        ...data,
        location: { name: 'North', whatsappGroupUrl: null },
      }),
    );
    const body = {
      name: 'Student',
      dob: '29/02/2020',
      school: '__other__',
      schoolOther: ' New School ',
      district: 'District',
      className: 'Standard 4',
      medium: 'English',
      syllabus: 'Board',
      parentPhone: '9876543210',
      whatsappPhone: '9876543211',
      locality: 'Village',
      guardianConsent: true,
    };
    await expect(
      controller.register('ABCDEFG', req, body),
    ).resolves.toMatchObject({
      location: { name: 'North', whatsappGroupUrl: null },
    });
    expect(db.student.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ school: 'New School' }),
      }),
    );
    (db.registrationOption.findMany as jest.Mock).mockResolvedValue([]);
    await expect(controller.register('ABCDEFG', req, body)).rejects.toThrow(
      'currently available',
    );
  });

  it('uses the persisted assigned location, suppresses invalid URLs, and never exposes them on lookup', async () => {
    (db.location.findUnique as jest.Mock).mockResolvedValue({
      id: 'loc',
      name: 'North',
      active: true,
      whatsappGroupUrl: 'https://evil.invalid/group',
    });
    (db.student.create as jest.Mock).mockResolvedValue({
      registrationId: 'EV-1',
      location: {
        name: 'South',
        whatsappGroupUrl: 'https://evil.invalid/group',
      },
    });
    const body = {
      name: 'Student',
      dob: '29/02/2020',
      school: 'School',
      district: 'District',
      className: 'Standard 4',
      medium: 'English',
      syllabus: 'Board',
      parentPhone: '9876543210',
      whatsappPhone: '9876543211',
      locality: 'Village',
      guardianConsent: true,
    };
    await expect(controller.resolve('ABCDEFG', req)).resolves.toEqual({
      name: 'North',
    });
    await expect(controller.register('ABCDEFG', req, body)).resolves.toEqual({
      registrationId: 'EV-1',
      location: { name: 'South', whatsappGroupUrl: null },
    });
  });

  it('returns only the authenticated student’s assigned location and filters invalid links', async () => {
    const studentRequest = {
      headers: { cookie: `edu_session=${'b'.repeat(64)}` },
      query: { locationId: 'another-location' },
    } as never;
    (db.session.findUnique as jest.Mock).mockResolvedValue({
      role: 'student',
      studentId: 'student-1',
      expiresAt: new Date(Date.now() + 10000),
    });
    (db.student.findUnique as jest.Mock).mockResolvedValue({
      name: 'Student',
      registrationId: 'EV-1',
      school: 'School',
      className: 'Standard 4',
      location: {
        name: 'North',
        whatsappGroupUrl: 'https://chat.whatsapp.com/Group123?mode=ac_t',
      },
    });
    await expect(controller.me(studentRequest)).resolves.toMatchObject({
      location: {
        name: 'North',
        whatsappGroupUrl: 'https://chat.whatsapp.com/Group123?mode=ac_t',
      },
    });
    expect(db.student.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'student-1' },
        select: expect.objectContaining({
          location: { select: { name: true, whatsappGroupUrl: true } },
        }),
      }),
    );
    (db.student.findUnique as jest.Mock).mockResolvedValueOnce({
      location: {
        name: 'North',
        whatsappGroupUrl: 'https://chat.whatsapp.com/Group123?x=1',
      },
    });
    await expect(controller.me(studentRequest)).resolves.toEqual({
      location: { name: 'North', whatsappGroupUrl: null },
    });
    (db.student.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await expect(controller.me(studentRequest)).rejects.toThrow('Unauthorized');
  });

  it('requires a registration ID for identical phone and date matches', async () => {
    (db.student.findMany as jest.Mock).mockResolvedValue([
      { id: 'a', registrationId: 'EV-A' },
      { id: 'b', registrationId: 'EV-B' },
    ]);
    const body = { phone: '9876543210', dob: '29/02/2020' };
    await expect(controller.studentLogin(req, res, body)).resolves.toEqual({
      requiresRegistrationId: true,
    });
    await expect(
      controller.studentLogin(req, res, { ...body, registrationId: 'EV-B' }),
    ).resolves.toEqual({ ok: true });
    expect(db.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ studentId: 'b', role: 'student' }),
      }),
    );
    await expect(
      controller.studentLogin(req, res, { ...body, registrationId: 'bad' }),
    ).rejects.toThrow('could not be verified');
  });

  it('rejects invalid dates without revealing which credential failed', async () => {
    await expect(
      controller.studentLogin(req, res, {
        phone: '9876543210',
        dob: '31/02/2020',
      }),
    ).rejects.toThrow('could not be verified');
  });

  it('limits repeated login attempts', async () => {
    (db.$queryRaw as jest.Mock).mockResolvedValue([{ count: 16 }]);
    await expect(
      controller.studentLogin(req, res, {
        phone: '9876543210',
        dob: '29/02/2020',
      }),
    ).rejects.toThrow('Too many requests');
    expect(db.student.findMany).not.toHaveBeenCalled();
  });

  it('does not allow a student session to access admin locations', async () => {
    (db.session.findUnique as jest.Mock).mockResolvedValue({
      role: 'student',
      expiresAt: new Date(Date.now() + 10000),
    });
    const studentRequest = {
      headers: { cookie: `edu_session=${'a'.repeat(64)}` },
    } as never;
    await expect(controller.locations(studentRequest)).rejects.toThrow();
  });

  describe('WhatsApp group management', () => {
    const adminRequest = {
      headers: {
        origin: 'http://localhost:3000',
        cookie: `edu_session=${'a'.repeat(64)}`,
      },
    } as never;
    const url = 'https://chat.whatsapp.com/Group123abc?mode=ac_t';

    beforeEach(() => {
      (db.session.findUnique as jest.Mock).mockResolvedValue({
        role: 'admin',
        adminId: 'admin-1',
        expiresAt: new Date(Date.now() + 10000),
      });
      (db.location.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    });

    it.each(['super_admin', 'exam_manager'])(
      'allows %s to update and clear, auditing without URLs',
      async (role) => {
        (db.adminAccount.findUnique as jest.Mock).mockResolvedValue({
          id: 'admin-1',
          username: 'admin',
          role,
        });
        await expect(
          controller.updateWhatsappGroup(adminRequest, 'loc', {
            whatsappGroupUrl: url,
          }),
        ).resolves.toEqual({ id: 'loc', whatsappGroupUrl: url });
        expect(db.location.updateMany).toHaveBeenCalledWith({
          where: { id: 'loc' },
          data: { whatsappGroupUrl: url },
        });
        expect(db.auditLog.create).toHaveBeenCalledWith({
          data: {
            action: 'location.whatsapp_group.updated',
            actor: 'admin-1',
            target: 'loc',
          },
        });
        await expect(
          controller.updateWhatsappGroup(adminRequest, 'loc', {
            whatsappGroupUrl: null,
          }),
        ).resolves.toEqual({ id: 'loc', whatsappGroupUrl: null });
        expect(db.location.updateMany).toHaveBeenLastCalledWith({
          where: { id: 'loc' },
          data: { whatsappGroupUrl: null },
        });
        (db.auditLog.create as jest.Mock).mockRejectedValueOnce(
          new Error('audit failed'),
        );
        await expect(
          controller.updateWhatsappGroup(adminRequest, 'loc', {
            whatsappGroupUrl: url,
          }),
        ).rejects.toThrow('audit failed');
      },
    );

    it('rejects invalid URLs and malformed bodies before updating', async () => {
      for (const value of [
        '',
        'http://chat.whatsapp.com/Group',
        'https://chat.whatsapp.com',
        'https://chat.whatsapp.com/',
        'https://chat.whatsapp.com/Group/extra',
        'https://chat.whatsapp.com/Group/',
        'https://chat.whatsapp.com/Group?x=1',
        'https://chat.whatsapp.com/Group?mode=',
        'https://chat.whatsapp.com/Group?MODE=ac_t',
        'https://chat.whatsapp.com/Group?mode=ac_t&redirect=https://evil.invalid',
        'https://chat.whatsapp.com/Group?mode=ac_t&mode=other',
        'https://chat.whatsapp.com/Group?mode=ac_t?redirect=evil',
        'https://chat.whatsapp.com/Group?mode=ac%5Ft',
        'https://chat.whatsapp.com/Group?mode=ac_t#fragment',
        'https://chat.whatsapp.com/Group?mode=ac_t\n',
        'https://chat.whatsapp.com/Group#x',
        'https://chat.whatsapp.com:444/Group',
        'https://chat.whatsapp.com.evil.invalid/Group',
        'https://user@chat.whatsapp.com/Group',
        'https://@chat.whatsapp.com/Group',
        'https://chat.whatsapp.com/%47roup',
        'https://chat.whatsapp.com/Group\n',
        'https://chat.whatsapp.com/../Group',
        42,
        false,
        undefined,
      ]) {
        await expect(
          controller.updateWhatsappGroup(adminRequest, 'loc', {
            whatsappGroupUrl: value,
          }),
        ).rejects.toThrow();
      }
      for (const body of [null, [], {}, { whatsappGroupUrl: url, other: 1 }]) {
        await expect(
          controller.updateWhatsappGroup(adminRequest, 'loc', body),
        ).rejects.toThrow();
      }
      expect(db.location.updateMany).not.toHaveBeenCalled();
      await expect(
        controller.updateWhatsappGroup(adminRequest, 'loc', {
          whatsappGroupUrl: 'https://chat.whatsapp.com:443/Group?mode=A-z_09',
        }),
      ).resolves.toMatchObject({
        whatsappGroupUrl: 'https://chat.whatsapp.com:443/Group?mode=A-z_09',
      });
    });

    it('rejects missing locations, unauthorised roles and cross-origin updates', async () => {
      (db.location.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });
      await expect(
        controller.updateWhatsappGroup(adminRequest, 'missing', {
          whatsappGroupUrl: url,
        }),
      ).rejects.toThrow('Location not found');
      expect(db.auditLog.create).not.toHaveBeenCalled();
      (db.adminAccount.findUnique as jest.Mock).mockResolvedValue({
        id: 'admin-1',
        username: 'reviewer',
        role: 'reviewer',
      });
      await expect(
        controller.updateWhatsappGroup(adminRequest, 'loc', {
          whatsappGroupUrl: url,
        }),
      ).rejects.toThrow('Forbidden');
      const foreign = {
        headers: {
          origin: 'https://other.invalid',
          cookie: `edu_session=${'a'.repeat(64)}`,
        },
      } as never;
      await expect(
        controller.updateWhatsappGroup(foreign, 'loc', {
          whatsappGroupUrl: url,
        }),
      ).rejects.toThrow('Invalid request origin');
      (db.session.findUnique as jest.Mock).mockResolvedValue({
        role: 'student',
        expiresAt: new Date(Date.now() + 10000),
      });
      await expect(
        controller.updateWhatsappGroup(adminRequest, 'loc', {
          whatsappGroupUrl: url,
        }),
      ).rejects.toThrow('Unauthorized');
      expect(db.location.updateMany).toHaveBeenCalledTimes(1);
    });

    it('sanitizes stored URLs in the admin location list', async () => {
      (db.location.findMany as jest.Mock).mockResolvedValue([
        { name: 'North', whatsappGroupUrl: url },
        { name: 'South', whatsappGroupUrl: 'https://evil.invalid/' },
        { name: 'West', whatsappGroupUrl: null },
      ]);
      await expect(controller.locations(adminRequest)).resolves.toEqual([
        { name: 'North', whatsappGroupUrl: url },
        { name: 'South', whatsappGroupUrl: null },
        { name: 'West', whatsappGroupUrl: null },
      ]);
    });
  });

  it('rejects cross-origin registration', async () => {
    const foreignRequest = {
      headers: { origin: 'https://other.invalid' },
    } as never;
    await expect(
      controller.register('ABCDEFG', foreignRequest, {}),
    ).rejects.toThrow('Invalid request origin');
  });

  it('validates registration windows and persists UTC instants', async () => {
    (db.session.findUnique as jest.Mock).mockResolvedValue({
      role: 'admin',
      adminId: 'admin-1',
      expiresAt: new Date(Date.now() + 10000),
    });
    (db.location.create as jest.Mock).mockResolvedValue({ id: 'loc' });
    const adminRequest = {
      headers: {
        origin: 'http://localhost:3000',
        cookie: `edu_session=${'a'.repeat(64)}`,
      },
    } as never;
    await expect(
      controller.createLocation(adminRequest, {
        name: 'North',
        opensAt: '2027-01-02T00:00:00Z',
        closesAt: '2027-01-01T00:00:00Z',
      }),
    ).rejects.toThrow('Closing time');
    await expect(
      controller.createLocation(adminRequest, {
        name: 'North',
        opensAt: '2027-01-01T00:00',
      }),
    ).rejects.toThrow('timezone');
    await expect(
      controller.createLocation(adminRequest, {
        name: 'North',
        opensAt: '2027-02-30T00:00:00Z',
      }),
    ).rejects.toThrow('valid date');
    await controller.createLocation(adminRequest, {
      name: 'North',
      opensAt: '2027-01-01T05:30:00+05:30',
      closesAt: '2027-01-02T00:00:00Z',
    });
    expect(db.location.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        opensAt: new Date('2027-01-01T00:00:00Z'),
      }),
    });
  });

  it('limits student listings to authorised admins and omits sensitive fields', async () => {
    (db.session.findUnique as jest.Mock).mockResolvedValue({
      role: 'admin',
      adminId: 'admin-1',
      expiresAt: new Date(Date.now() + 10000),
    });
    (db.student.findMany as jest.Mock).mockResolvedValue([]);
    (db.student.count as jest.Mock).mockResolvedValue(0);
    const adminRequest = {
      headers: { cookie: `edu_session=${'a'.repeat(64)}` },
    } as never;
    await expect(
      controller.students(adminRequest, 'school', 'loc', '1'),
    ).resolves.toEqual({ students: [], total: 0, page: 1 });
    const query = (db.student.findMany as jest.Mock).mock.calls[0][0];
    expect(query.select).not.toHaveProperty('dob');
    expect(query.select).not.toHaveProperty('parentPhone');
    expect(query.where.locationId).toBe('loc');
    await expect(
      controller.students(adminRequest, undefined, undefined, '-1'),
    ).rejects.toThrow('Invalid filter');
  });

  describe('individual admin accounts', () => {
    const db = new PrismaClient();
    const controller = new AppController();
    const req = {
      ip: '127.0.0.1',
      headers: {
        origin: 'http://localhost:3000',
        cookie: `edu_session=${'a'.repeat(64)}`,
      },
    } as never;
    const res = { cookie: jest.fn(), clearCookie: jest.fn() } as never;
    let encoded: string;

    beforeAll(async () => {
      encoded = await hashPassword('a secure password');
    });
    beforeEach(() => {
      jest.clearAllMocks();
      process.env.WEB_ORIGIN = 'http://localhost:3000';
      process.env.RATE_LIMIT_SECRET =
        'test-secret-with-more-than-32-characters';
      (db.$queryRaw as jest.Mock).mockResolvedValue([
        { count: 1, id: 'admin-1' },
      ]);
      (db.session.findUnique as jest.Mock).mockResolvedValue({
        role: 'admin',
        adminId: 'admin-1',
        expiresAt: new Date(Date.now() + 10000),
      });
      (db.adminAccount.findUnique as jest.Mock).mockResolvedValue({
        id: 'admin-1',
        username: 'admin',
        role: 'super_admin',
        passwordHash: encoded,
      });
    });

    it('uses salted scrypt and rejects incorrect passwords', async () => {
      const another = await hashPassword('a secure password');
      expect(another).not.toEqual(encoded);
      await expect(verifyPassword('a secure password', encoded)).resolves.toBe(
        true,
      );
      await expect(verifyPassword('incorrect password', encoded)).resolves.toBe(
        false,
      );
      await expect(
        verifyPassword('a secure password', 'malformed'),
      ).resolves.toBe(false);
    });

    it('logs in with an individual account and never returns its hash', async () => {
      const result = await controller.adminLogin(req, res, {
        username: 'ADMIN',
        password: 'a secure password',
      });
      expect(result).toEqual({
        ok: true,
        admin: { id: 'admin-1', username: 'admin', role: 'super_admin' },
      });
      expect(db.session.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: 'admin', adminId: 'admin-1' }),
        }),
      );
      await expect(
        controller.adminLogin(req, res, { username: 'admin', password: 'bad' }),
      ).rejects.toThrow('could not be verified');
      (db.adminAccount.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        controller.adminLogin(req, res, {
          username: 'missing',
          password: 'bad',
        }),
      ).rejects.toThrow('could not be verified');
    });

    it('rejects legacy, expired, missing-account and student sessions', async () => {
      for (const session of [
        { role: 'admin', expiresAt: new Date(Date.now() + 10000) },
        { role: 'admin', adminId: 'admin-1', expiresAt: new Date(0) },
        {
          role: 'student',
          adminId: 'admin-1',
          expiresAt: new Date(Date.now() + 10000),
        },
      ]) {
        (db.session.findUnique as jest.Mock).mockResolvedValueOnce(session);
        await expect(controller.adminMe(req)).rejects.toThrow('Unauthorized');
      }
      (db.adminAccount.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(controller.adminMe(req)).rejects.toThrow('Unauthorized');
    });

    it('limits reviewer mutations and account management', async () => {
      (db.adminAccount.findUnique as jest.Mock).mockResolvedValue({
        id: 'admin-1',
        username: 'reader',
        role: 'reviewer',
      });
      await expect(controller.adminMe(req)).resolves.toEqual({
        id: 'admin-1',
        username: 'reader',
        role: 'reviewer',
      });
      await expect(
        controller.createLocation(req, { name: 'North' }),
      ).rejects.toThrow('Forbidden');
      await expect(controller.accounts(req)).rejects.toThrow('Forbidden');
      (db.adminAccount.findUnique as jest.Mock).mockResolvedValue({
        id: 'admin-1',
        username: 'manager',
        role: 'exam_manager',
      });
      await expect(controller.accounts(req)).rejects.toThrow('Forbidden');
    });

    it('changes the password atomically and invalidates every session', async () => {
      await expect(
        controller.changePassword(req, res, {
          currentPassword: 'wrong',
          newPassword: 'a new secure password',
        }),
      ).rejects.toThrow('could not be verified');
      await controller.changePassword(req, res, {
        currentPassword: 'a secure password',
        newPassword: 'a new secure password',
      });
      const hash = (db.adminAccount.update as jest.Mock).mock.calls[0][0].data
        .passwordHash;
      await expect(verifyPassword('a new secure password', hash)).resolves.toBe(
        true,
      );
      expect(db.session.deleteMany).toHaveBeenCalledWith({
        where: { adminId: 'admin-1' },
      });
      expect(
        (res as unknown as { clearCookie: jest.Mock }).clearCookie,
      ).toHaveBeenCalled();
    });

    it('prevents demoting the last super admin', async () => {
      (db.adminAccount.count as jest.Mock).mockResolvedValue(1);
      await expect(
        controller.updateAccount(req, 'admin-1', { role: 'reviewer' }),
      ).rejects.toThrow('At least one super admin');
      expect(db.adminAccount.update).not.toHaveBeenCalled();
    });

    it('creates accounts with hashed credentials and resets their sessions', async () => {
      (db.adminAccount.create as jest.Mock).mockResolvedValue({
        id: 'admin-2',
        username: 'reader',
        role: 'reviewer',
      });
      await controller.createAccount(req, {
        username: 'Reader',
        password: 'a secure password',
        role: 'reviewer',
      });
      const data = (db.adminAccount.create as jest.Mock).mock.calls[0][0].data;
      expect(data.username).toBe('reader');
      expect(data.passwordHash).not.toBe('a secure password');
      await expect(
        verifyPassword('a secure password', data.passwordHash),
      ).resolves.toBe(true);
      await controller.updateAccount(req, 'admin-2', {
        password: 'a different password',
      });
      expect(db.session.deleteMany).toHaveBeenCalledWith({
        where: { adminId: 'admin-2' },
      });
    });

    it('rejects login if the password changes before session creation', async () => {
      (db.adminAccount.findUnique as jest.Mock)
        .mockResolvedValueOnce({
          id: 'admin-1',
          username: 'admin',
          role: 'super_admin',
          passwordHash: encoded,
        })
        .mockResolvedValueOnce({
          id: 'admin-1',
          username: 'admin',
          role: 'super_admin',
          passwordHash: 'changed',
        });
      await expect(
        controller.adminLogin(req, res, {
          username: 'admin',
          password: 'a secure password',
        }),
      ).rejects.toThrow('Unauthorized');
      expect(db.session.create).not.toHaveBeenCalled();
    });

    it('enforces origin on account mutations', async () => {
      const foreign = {
        headers: {
          origin: 'https://other.invalid',
          cookie: `edu_session=${'a'.repeat(64)}`,
        },
      } as never;
      await expect(
        controller.createAccount(foreign, {
          username: 'reviewer',
          password: 'a secure password',
          role: 'reviewer',
        }),
      ).rejects.toThrow('Invalid request origin');
    });
  });

  it('fails closed when the rate-limit secret is missing', async () => {
    delete process.env.RATE_LIMIT_SECRET;
    await expect(controller.resolve('ABCDEFG', req)).rejects.toThrow(
      'Rate limiting is not configured',
    );
  });
});
