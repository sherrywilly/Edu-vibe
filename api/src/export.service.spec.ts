import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import type { Request, Response } from 'express';
import { Test } from '@nestjs/testing';
import requestHttp from 'supertest';
import { ExportController } from './export.controller';
import { csvCell, ExportService } from './export.service';

describe('registration exports', () => {
  const token = 'a'.repeat(64);
  const request = { headers: { cookie: `edu_session=${token}` } } as Request;
  const student = {
    registrationId: 'REG-1',
    name: '=2+2',
    school: 'School, "A"',
    district: 'District',
    className: '4',
    medium: 'English',
    syllabus: 'Board',
    locality: 'Village',
    location: { name: 'Centre' },
    createdAt: new Date('2026-01-02T03:04:05Z'),
  };
  let service: ExportService;
  let db: {
    $disconnect: jest.Mock;
    session: { findUnique: jest.Mock };
    adminAccount: { findUnique: jest.Mock };
    student: { findMany: jest.Mock; findUnique: jest.Mock };
  };

  beforeEach(() => {
    service = new ExportService();
    db = {
      $disconnect: jest.fn().mockResolvedValue(undefined),
      session: {
        findUnique: jest.fn().mockResolvedValue({
          role: 'admin',
          adminId: 'admin-1',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      adminAccount: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-1',
          role: 'super_admin',
          username: 'admin',
        }),
      },
      student: {
        findMany: jest.fn().mockResolvedValue([student]),
        findUnique: jest.fn().mockResolvedValue(student),
      },
    };
    Object.defineProperty(service, 'db', { value: db });
  });

  it('authenticates active admin sessions and rejects absent, expired, wrong-role and removed accounts', async () => {
    await expect(service.authorize(request)).resolves.toMatchObject({
      id: 'admin-1',
    });
    expect(db.session.findUnique).toHaveBeenCalledWith({
      where: { id: createHash('sha256').update(token).digest('hex') },
    });
    await expect(
      service.authorize({ headers: {} } as Request),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    db.session.findUnique.mockResolvedValueOnce({
      role: 'student',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(service.authorize(request)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    db.session.findUnique.mockResolvedValueOnce({
      role: 'admin',
      adminId: 'admin-1',
      expiresAt: new Date(0),
    });
    await expect(service.authorize(request)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    db.adminAccount.findUnique.mockResolvedValueOnce(null);
    await expect(service.authorize(request)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('neutralizes spreadsheet formulas and quotes CSV cells', () => {
    expect(csvCell(' \t=SUM(1,2)')).toBe('"\' \t=SUM(1,2)"');
    expect(csvCell('\ttext')).toBe('"\'\ttext"');
    expect(csvCell('-1')).toBe('"\'-1"');
    expect(csvCell('"+1",test')).toBe('"""+1"",test"');
  });

  it('exports all matching rows with the same filters and excludes sensitive fields', async () => {
    const result = await service.registrations(' village ', 'loc-1');
    const query = db.student.findMany.mock.calls[0][0];
    expect(query.where.locationId).toBe('loc-1');
    expect(query.where.OR).toEqual(
      expect.arrayContaining([
        { locality: { contains: 'village', mode: 'insensitive' } },
      ]),
    );
    expect(query.select).not.toHaveProperty('dob');
    expect(query.select).not.toHaveProperty('parentPhone');
    expect(query.select).not.toHaveProperty('whatsappPhone');
    expect(query.skip).toBeUndefined();
    expect(result).toContain('"\'=2+2"');
    expect(result).toContain('"School, ""A"""');
    expect(result).not.toContain('Phone');
    await expect(service.registrations(['bad'], '')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    db.student.findMany.mockResolvedValueOnce(Array(10001).fill(student));
    await expect(service.registrations('', '')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('produces an individual PDF and reports missing records', async () => {
    const pdf = await service.acknowledgement('student-1');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(db.student.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'student-1' } }),
    );
    db.student.findUnique.mockResolvedValueOnce(null);
    await expect(service.acknowledgement('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('fails safely for Unicode when no PDF font is configured', async () => {
    const font = process.env.PDF_FONT_PATH;
    delete process.env.PDF_FONT_PATH;
    try {
      db.student.findUnique.mockResolvedValueOnce({
        ...student,
        name: 'विद्यार्थी',
      });
      await expect(service.acknowledgement('student-1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    } finally {
      if (font !== undefined) process.env.PDF_FONT_PATH = font;
    }
  });

  it('rejects unauthorized HTTP downloads and serves authenticated private attachments', async () => {
    const module = await Test.createTestingModule({
      controllers: [ExportController],
      providers: [{ provide: ExportService, useValue: service }],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      await requestHttp(app.getHttpServer())
        .get('/admin/students/export.csv')
        .expect(401);
      await requestHttp(app.getHttpServer())
        .get('/admin/students/student-1/acknowledgement.pdf')
        .expect(401);
      expect(db.student.findMany).not.toHaveBeenCalled();
      expect(db.student.findUnique).not.toHaveBeenCalled();
      await requestHttp(app.getHttpServer())
        .get('/admin/students/export.csv?search=Village&locationId=loc-1')
        .set('Cookie', `edu_session=${token}`)
        .expect('Content-Type', /text\/csv/)
        .expect('Cache-Control', 'private, no-store')
        .expect(200);
      await requestHttp(app.getHttpServer())
        .get('/admin/students/student-1/acknowledgement.pdf')
        .set('Cookie', `edu_session=${token}`)
        .expect('Content-Type', /application\/pdf/)
        .expect('Cache-Control', 'private, no-store')
        .expect(200);
    } finally {
      await app.close();
    }
  });

  it('authorizes before accessing either export and sets safe download headers', async () => {
    const controller = new ExportController(service);
    const res = { set: jest.fn(), send: jest.fn() } as unknown as Response;
    const authorize = jest
      .spyOn(service, 'authorize')
      .mockRejectedValueOnce(new ForbiddenException());
    await expect(controller.registrations(request, res)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(db.student.findMany).not.toHaveBeenCalled();
    authorize.mockRejectedValueOnce(new UnauthorizedException());
    await expect(
      controller.acknowledgement(request, res, 'student-1'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.student.findUnique).not.toHaveBeenCalled();
    authorize.mockResolvedValue({
      id: 'admin-1',
      username: 'admin',
      role: 'super_admin',
    });
    await controller.registrations(request, res);
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'attachment; filename="registrations.csv"',
      }),
    );
    await controller.acknowledgement(request, res, 'student-1');
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Content-Type': 'application/pdf',
        'Content-Disposition':
          'attachment; filename="registration-acknowledgement.pdf"',
      }),
    );
  });
});
