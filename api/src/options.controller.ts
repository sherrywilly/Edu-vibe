import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { authenticateAdmin } from './auth';
import { optionsDb, optionsService } from './options.service';

@Controller()
export class OptionsController {
  @Get('registration-options')
  listPublic() {
    return optionsService.list();
  }

  @Get('admin/options')
  async listAdmin(@Req() req: Request) {
    await authenticateAdmin(optionsDb, req);
    return optionsService.list(false);
  }

  @Post('admin/options')
  async create(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const admin = await authenticateAdmin(
      optionsDb,
      req,
      ['super_admin', 'exam_manager'],
      true,
    );
    return optionsService.create(body, admin.id);
  }

  @Post('admin/options/:id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const admin = await authenticateAdmin(
      optionsDb,
      req,
      ['super_admin', 'exam_manager'],
      true,
    );
    return optionsService.update(id, body, admin.id);
  }
}
