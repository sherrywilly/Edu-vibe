import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ExamService } from './exam.service';
import { AttemptNotesService } from './attempt-notes.service';

@Controller()
export class AttemptNotesController {
  constructor(
    private readonly exams: ExamService,
    private readonly notes: AttemptNotesService,
  ) {}

  @Get('student/attempts/:id/notes')
  async get(@Req() req: Request, @Param('id') id: string) {
    const session = await this.exams.authenticate(req, 'student');
    return this.notes.get(id, session.studentId!);
  }

  @Put('student/attempts/:id/flags/:questionId')
  async flag(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('questionId') questionId: string,
    @Body() body: unknown,
  ) {
    const session = await this.exams.authenticate(req, 'student', true);
    return this.notes.setFlag(id, session.studentId!, questionId, body);
  }

  @Post('student/attempts/:id/events')
  async event(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const session = await this.exams.authenticate(req, 'student', true);
    return this.notes.recordEvent(id, session.studentId!, body);
  }

  @Get('admin/attempts')
  async list(@Req() req: Request, @Query() query: Record<string, unknown>) {
    await this.notes.authenticateAdmin(req);
    return this.notes.listAttempts(query);
  }

  @Get('admin/attempts/:id/events/summary')
  async summary(@Req() req: Request, @Param('id') id: string) {
    await this.notes.authenticateAdmin(req);
    return this.notes.eventSummary(id);
  }
}
