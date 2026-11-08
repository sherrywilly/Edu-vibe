import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ExamService } from './exam.service';
import { PrismaClient } from '@prisma/client';
import { authenticateAdmin } from './auth';

const db = new PrismaClient();

@Controller()
export class ExamController {
  constructor(private readonly exams: ExamService) {}

  @Post('admin/exams')
  async create(@Req() req: Request, @Body() body: unknown) {
    const admin = await authenticateAdmin(
      db,
      req,
      ['super_admin', 'exam_manager'],
      true,
    );
    return this.exams.createExam(body, admin.id);
  }

  @Get('admin/exams')
  async adminList(@Req() req: Request) {
    await authenticateAdmin(db, req);
    return this.exams.listAdmin();
  }

  @Post('admin/exams/:id/schedules')
  async schedule(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const admin = await authenticateAdmin(
      db,
      req,
      ['super_admin', 'exam_manager'],
      true,
    );
    return this.exams.schedule(id, body, admin.id);
  }

  @Put('admin/exams/:id/schedules/:scheduleId')
  async updateSchedule(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('scheduleId') scheduleId: string,
    @Body() body: unknown,
  ) {
    const admin = await authenticateAdmin(
      db,
      req,
      ['super_admin', 'exam_manager'],
      true,
    );
    return this.exams.schedule(id, body, admin.id, scheduleId);
  }

  @Delete('admin/exams/:id/schedules/:scheduleId')
  async cancelSchedule(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('scheduleId') scheduleId: string,
  ) {
    const admin = await authenticateAdmin(
      db,
      req,
      ['super_admin', 'exam_manager'],
      true,
    );
    return this.exams.cancelSchedule(id, scheduleId, admin.id);
  }

  @Patch('admin/exams/:id/results')
  async publish(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const admin = await authenticateAdmin(db, req, ['super_admin'], true);
    return this.exams.publish(id, body, admin.id);
  }

  @Get('student/exams')
  async studentList(@Req() req: Request) {
    const session = await this.exams.authenticate(req, 'student');
    return this.exams.listStudent(session.studentId!);
  }

  @Post('student/exams/:id/start')
  async start(@Req() req: Request, @Param('id') id: string) {
    const session = await this.exams.authenticate(req, 'student', true);
    return this.exams.start(id, session.studentId!);
  }

  @Get('student/attempts/:id')
  async attempt(@Req() req: Request, @Param('id') id: string) {
    const session = await this.exams.authenticate(req, 'student');
    return this.exams.getAttempt(id, session.studentId!);
  }

  @Put('student/attempts/:id/answers')
  async save(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const session = await this.exams.authenticate(req, 'student', true);
    return this.exams.save(id, session.studentId!, body);
  }

  @Post('student/attempts/:id/submit')
  async submit(@Req() req: Request, @Param('id') id: string) {
    const session = await this.exams.authenticate(req, 'student', true);
    return this.exams.submit(id, session.studentId!);
  }
}
