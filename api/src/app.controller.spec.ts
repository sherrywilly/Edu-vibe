import { AppController } from './app.controller';
import { PrismaClient } from '@prisma/client';

jest.mock('@prisma/client', () => {
  const instance = {
    $queryRaw: jest.fn().mockResolvedValue([{ count: 1 }]),
    location: { findUnique: jest.fn(), create: jest.fn() },
    student: { findMany: jest.fn(), create: jest.fn(), count: jest.fn() },
    session: { create: jest.fn(), findUnique: jest.fn() },
    auditLog: { create: jest.fn() },
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
    process.env.RATE_LIMIT_SECRET = 'test-secret-with-more-than-32-characters';
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

  it('validates registration windows and persists UTC instants', async () => {
    (db.session.findUnique as jest.Mock).mockResolvedValue({ role: 'admin', expiresAt: new Date(Date.now() + 10000) });
    (db.location.create as jest.Mock).mockResolvedValue({ id: 'loc' });
    const adminRequest = { headers: { origin: 'http://localhost:3000', cookie: `edu_session=${'a'.repeat(64)}` } } as never;
    await expect(controller.createLocation(adminRequest, { name: 'North', opensAt: '2027-01-02T00:00:00Z', closesAt: '2027-01-01T00:00:00Z' })).rejects.toThrow('Closing time');
    await expect(controller.createLocation(adminRequest, { name: 'North', opensAt: '2027-01-01T00:00' })).rejects.toThrow('timezone');
    await expect(controller.createLocation(adminRequest, { name: 'North', opensAt: '2027-02-30T00:00:00Z' })).rejects.toThrow('valid date');
    await controller.createLocation(adminRequest, { name: 'North', opensAt: '2027-01-01T05:30:00+05:30', closesAt: '2027-01-02T00:00:00Z' });
    expect(db.location.create).toHaveBeenCalledWith({ data: expect.objectContaining({ opensAt: new Date('2027-01-01T00:00:00Z') }) });
  });

  it('limits student listings to authorised admins and omits sensitive fields', async () => {
    (db.session.findUnique as jest.Mock).mockResolvedValue({ role: 'admin', expiresAt: new Date(Date.now() + 10000) });
    (db.student.findMany as jest.Mock).mockResolvedValue([]);
    (db.student.count as jest.Mock).mockResolvedValue(0);
    const adminRequest = { headers: { cookie: `edu_session=${'a'.repeat(64)}` } } as never;
    await expect(controller.students(adminRequest, 'school', 'loc', '1')).resolves.toEqual({ students: [], total: 0, page: 1 });
    const query = (db.student.findMany as jest.Mock).mock.calls[0][0];
    expect(query.select).not.toHaveProperty('dob');
    expect(query.select).not.toHaveProperty('parentPhone');
    expect(query.where.locationId).toBe('loc');
    await expect(controller.students(adminRequest, undefined, undefined, '-1')).rejects.toThrow('Invalid filter');
  });

  it('fails closed when the rate-limit secret is missing', async () => {
    delete process.env.RATE_LIMIT_SECRET;
    await expect(controller.resolve('ABCDEFG', req)).rejects.toThrow('Rate limiting is not configured');
  });
});
