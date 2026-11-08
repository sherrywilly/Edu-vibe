import { Body, Controller, Get, Param, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import { authenticateAdmin } from './auth';
import { LocationService } from './location.service';

@Controller('admin/locations')
export class LocationController {
  constructor(private readonly locations: LocationService) {}

  @Patch(':id/window')
  async updateWindow(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const admin = await authenticateAdmin(
      this.locations.database,
      req,
      ['super_admin', 'exam_manager'],
      true,
    );
    return this.locations.updateWindow(id, body, admin.id);
  }

  @Get(':id/history')
  async history(@Req() req: Request, @Param('id') id: string) {
    await authenticateAdmin(this.locations.database, req);
    return this.locations.history(id);
  }
}
