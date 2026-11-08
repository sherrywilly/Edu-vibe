import { AppController } from './app.controller';
import { PrismaClient } from '@prisma/client';

jest.mock('@prisma/client', () => {
  const instance = {
    $queryRaw: jest.fn().mockResolvedValue([{ count: 1 }]),
    location: { findUnique: jest.fn() },
    student: { findMany: jest.fn(), create: jest.fn() },
    session: { create: jest.fn(), findUnique: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => instance) };
});

describe('registration and student authentication', () => {
  const db = new PrismaClient();
  const controller = new AppController();
  const req = { ip: '127.0.0.1', headers: { origin: 'http://localhost:3000' } } as never;
  const res = { cookie: jest.fn() } as never;

  beforeEach(() => {
    process.env.WEB_ORIGIN = 'http://localhost:3000';
    jest.clearAllMocks();
    (db.$queryRaw as jest.Mock).mockResolvedValue([{ count: 1 }]);
  });

  it('resolves only active links within their window', async () => {
    const find = db.location.findUnique as jest.Mock;
    find.mockResolvedValueOnce(null).mockResolvedValueOnce({ active: false })
      .mockResolvedValueOnce({ active: true, closesAt: new Date(0) })
      .mockResolvedValueOnce({ name: 'North', active: true });
    await expect(controller.resolve('ABCDEFG', req)).rejects.toThrow('invalid');
    await expect(controller.resolve('ABCDEFG', req)).rejects.toThrow('inactive');
    await expect(controller.resolve('ABCDEFG', req)).rejects.toThrow('expired');
    await expect(controller.resolve('ABCDEFG', req)).resolves.toEqual({ name: 'North' });
  });

  it('assigns the server-resolved location and keeps phone numbers separate', async () => {
    (db.location.findUnique as jest.Mock).mockResolvedValue({ id: 'real-location', active: true });
    (db.student.create as jest.Mock).mockImplementation(({ data }) => Promise.resolve(data));
    await controller.register('ABCDEFG', req, {
      name: 'Student', dob: '29/02/2020', school: 'School', district: 'District',
      className: 'Standard 4', medium: 'English', syllabus: 'Board', parentPhone: '9876543210',
      whatsappPhone: '+919876543211', locality: 'Village', guardianConsent: true, locationId: 'forged',
    });
    expect(db.student.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ locationId: 'real-location', parentPhone: '+919876543210', whatsappPhone: '+919876543211', whatsappConsentAt: null }),
    }));
  });

  it('requires a registration ID for identical phone and date matches', async () => {
    (db.student.findMany as jest.Mock).mockResolvedValue([{ id: 'a', registrationId: 'EV-A' }, { id: 'b', registrationId: 'EV-B' }]);
    const body = { phone: '9876543210', dob: '29/02/2020' };
    await expect(controller.studentLogin(req, res, body)).resolves.toEqual({ requiresRegistrationId: true });
    await expect(controller.studentLogin(req, res, { ...body, registrationId: 'EV-B' })).resolves.toEqual({ ok: true });
    expect(db.session.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ studentId: 'b', role: 'student' }) }));
    await expect(controller.studentLogin(req, res, { ...body, registrationId: 'bad' })).rejects.toThrow('could not be verified');
  });

  it('rejects invalid dates without revealing which credential failed', async () => {
    await expect(controller.studentLogin(req, res, { phone: '9876543210', dob: '31/02/2020' })).rejects.toThrow('could not be verified');
  });

  it('limits repeated login attempts', async () => {
    (db.$queryRaw as jest.Mock).mockResolvedValue([{ count: 16 }]);
    await expect(controller.studentLogin(req, res, { phone: '9876543210', dob: '29/02/2020' })).rejects.toThrow('Too many requests');
    expect(db.student.findMany).not.toHaveBeenCalled();
  });

  it('does not allow a student session to access admin locations', async () => {
    (db.session.findUnique as jest.Mock).mockResolvedValue({ role: 'student', expiresAt: new Date(Date.now() + 10000) });
    const studentRequest = { headers: { cookie: `edu_session=${'a'.repeat(64)}` } } as never;
    await expect(controller.locations(studentRequest)).rejects.toThrow();
  });

  it('rejects cross-origin registration', async () => {
    const foreignRequest = { headers: { origin: 'https://other.invalid' } } as never;
    await expect(controller.register('ABCDEFG', foreignRequest, {})).rejects.toThrow('Invalid request origin');
  });
});
