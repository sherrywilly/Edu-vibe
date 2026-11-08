import { PrismaClient } from '@prisma/client';
import { ExamController } from './exam.controller';
import type { ExamService } from './exam.service';

jest.mock('@prisma/client', () => {
  const instance = {
    session: { findUnique: jest.fn() },
    adminAccount: { findUnique: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => instance) };
});

describe('exam endpoint authorization', () => {
  const db = new PrismaClient();
  const exams = {
    createExam: jest.fn(),
    listAdmin: jest.fn(),
    schedule: jest.fn(),
    publish: jest.fn(),
    authenticate: jest.fn().mockResolvedValue({ studentId: 'student-1' }),
    listStudent: jest.fn(),
  };
  const controller = new ExamController(exams as unknown as ExamService);
  const req = {
    headers: {
      origin: 'http://localhost:3000',
      cookie: `edu_session=${'a'.repeat(64)}`,
    },
  } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WEB_ORIGIN = 'http://localhost:3000';
    (db.session.findUnique as jest.Mock).mockResolvedValue({
      role: 'admin',
      adminId: 'a',
      expiresAt: new Date(Date.now() + 10000),
    });
  });

  it('lets reviewers read but denies exam mutations', async () => {
    (db.adminAccount.findUnique as jest.Mock).mockResolvedValue({
      id: 'a',
      username: 'reader',
      role: 'reviewer',
    });
    await controller.adminList(req);
    await expect(controller.create(req, {})).rejects.toThrow('Forbidden');
    await expect(controller.schedule(req, 'exam', {})).rejects.toThrow(
      'Forbidden',
    );
    await expect(controller.publish(req, 'exam', {})).rejects.toThrow(
      'Forbidden',
    );
    expect(exams.createExam).not.toHaveBeenCalled();
  });

  it('allows exam managers to create and schedule but not publish results', async () => {
    (db.adminAccount.findUnique as jest.Mock).mockResolvedValue({
      id: 'a',
      username: 'manager',
      role: 'exam_manager',
    });
    await controller.create(req, {});
    await controller.schedule(req, 'exam', {});
    await expect(controller.publish(req, 'exam', {})).rejects.toThrow(
      'Forbidden',
    );
    expect(exams.createExam).toHaveBeenCalledWith({}, 'a');
    expect(exams.schedule).toHaveBeenCalledWith('exam', {}, 'a');
  });

  it('permits super admins to publish and still delegates student authentication', async () => {
    (db.adminAccount.findUnique as jest.Mock).mockResolvedValue({
      id: 'a',
      username: 'root',
      role: 'super_admin',
    });
    await controller.publish(req, 'exam', {});
    expect(exams.publish).toHaveBeenCalledWith('exam', {}, 'a');
    await controller.studentList(req);
    expect(exams.authenticate).toHaveBeenCalledWith(req, 'student');
    expect(exams.listStudent).toHaveBeenCalledWith('student-1');
  });
});
