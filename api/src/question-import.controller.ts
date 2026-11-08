import { Body, Controller, Post, Req } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { authenticateAdmin } from './auth';
import { QuestionImportService } from './question-import.service';

@Controller('admin/question-imports')
export class QuestionImportController {
  private readonly authDb = new PrismaClient();
  constructor(private readonly imports: QuestionImportService) {}

  async onModuleDestroy() {
    await this.authDb.$disconnect();
  }

  @Post('preview')
  async preview(@Req() req: Request, @Body() body: unknown) {
    await authenticateAdmin(
      this.authDb,
      req,
      ['super_admin', 'exam_manager'],
      true,
    );
    return this.imports.preview(body);
  }
}
