import { Body, Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateAdmin } from './auth';
import { ImportService } from './import.service';

@Controller('admin/imports')
export class ImportController {
  private readonly authDb = new PrismaClient();
  constructor(private readonly imports: ImportService) {}

  async onModuleDestroy() {
    await this.authDb.$disconnect();
  }

  @Post('preview')
  async preview(@Req() req: Request, @Body() body: unknown) {
    await authenticateAdmin(this.authDb, req, ['super_admin'], true);
    return this.imports.preview(body);
  }

  @Post('confirm')
  async confirm(@Req() req: Request, @Body() body: unknown) {
    const admin = await authenticateAdmin(
      this.authDb,
      req,
      ['super_admin'],
      true,
    );
    return this.imports.confirm(body, admin.id);
  }
}
