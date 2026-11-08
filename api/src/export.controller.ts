import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ExportService } from './export.service';

@Controller()
export class ExportController {
  constructor(private readonly exports: ExportService) {}

  @Get('admin/students/export.csv')
  async registrations(
    @Req() req: Request,
    @Res() res: Response,
    @Query('search') search?: unknown,
    @Query('locationId') locationId?: unknown,
  ) {
    await this.exports.authorize(req);
    const csv = await this.exports.registrations(search, locationId);
    res.set({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="registrations.csv"',
    });
    res.send(csv);
  }

  @Get('admin/students/:id/acknowledgement.pdf')
  async acknowledgement(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
  ) {
    await this.exports.authorize(req);
    const pdf = await this.exports.acknowledgement(id);
    res.set({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': 'application/pdf',
      'Content-Disposition':
        'attachment; filename="registration-acknowledgement.pdf"',
    });
    res.send(pdf);
  }
}
