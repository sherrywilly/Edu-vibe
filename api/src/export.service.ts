import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import PDFDocument from 'pdfkit';
import type { Request } from 'express';
import { authenticateAdmin } from './auth';

const maxExportRows = 10_000;
const fields = [
  'name',
  'registrationId',
  'school',
  'district',
  'className',
  'medium',
  'syllabus',
  'locality',
] as const;
const studentSelect = {
  registrationId: true,
  name: true,
  school: true,
  district: true,
  className: true,
  medium: true,
  syllabus: true,
  locality: true,
  createdAt: true,
  location: { select: { name: true } },
} satisfies Prisma.StudentSelect;

export function csvCell(value: string): string {
  // Spreadsheet programs may ignore leading whitespace before interpreting a formula.
  const safe =
    /^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(value) || /^[\t\r\n]/u.test(value)
      ? `'${value}`
      : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

@Injectable()
export class ExportService implements OnModuleDestroy {
  private readonly db = new PrismaClient();

  async onModuleDestroy() {
    await this.db.$disconnect();
  }

  async authorize(req: Request) {
    return authenticateAdmin(this.db, req);
  }

  async registrations(search: unknown, locationId: unknown) {
    if (
      (search !== undefined &&
        (typeof search !== 'string' || search.length > 120)) ||
      (locationId !== undefined &&
        (typeof locationId !== 'string' || locationId.length > 100))
    ) {
      throw new BadRequestException('Invalid filter.');
    }
    const term = typeof search === 'string' ? search.trim() : '';
    const where: Prisma.StudentWhereInput = {
      ...(locationId ? { locationId: locationId } : {}),
      ...(term
        ? {
            OR: fields.map((field) => ({
              [field]: { contains: term, mode: 'insensitive' as const },
            })),
          }
        : {}),
    };
    const students = await this.db.student.findMany({
      where,
      select: studentSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: maxExportRows + 1,
    });
    if (students.length > maxExportRows)
      throw new BadRequestException(
        'Too many registrations to export. Narrow the filters.',
      );
    const rows = [
      [
        'Registration ID',
        'Name',
        'School',
        'District',
        'Class',
        'Medium',
        'Syllabus',
        'Locality',
        'Registration location',
        'Registered at (UTC)',
      ],
      ...students.map((s) => [
        s.registrationId,
        s.name,
        s.school,
        s.district,
        s.className,
        s.medium,
        s.syllabus,
        s.locality,
        s.location.name,
        s.createdAt.toISOString(),
      ]),
    ];
    return (
      '\uFEFF' +
      rows.map((row) => row.map(csvCell).join(',')).join('\r\n') +
      '\r\n'
    );
  }

  async acknowledgement(id: string): Promise<Buffer> {
    if (typeof id !== 'string' || !id || id.length > 100)
      throw new NotFoundException();
    const student = await this.db.student.findUnique({
      where: { id },
      select: studentSelect,
    });
    if (!student) throw new NotFoundException();
    const lines = [
      ['Registration ID', student.registrationId],
      ['Student name', student.name],
      ['School', student.school],
      ['District', student.district],
      ['Class', student.className],
      ['Medium', student.medium],
      ['Syllabus', student.syllabus],
      ['Locality', student.locality],
      ['Registration location', student.location.name],
      ['Registered at (UTC)', student.createdAt.toISOString()],
    ];
    const font = process.env.PDF_FONT_PATH;
    if (!font && lines.some(([, value]) => /[^\x20-\x7e]/.test(value))) {
      throw new ServiceUnavailableException(
        'A Unicode PDF font is required to generate this acknowledgement.',
      );
    }
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        margin: 50,
        info: { Title: 'Registration acknowledgement' },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      try {
        if (font) doc.font(font);
        doc.fontSize(20).text('Registration acknowledgement');
        doc
          .moveDown()
          .fontSize(11)
          .text('Your registration has been received.');
        doc.moveDown();
        for (const [label, value] of lines) {
          doc
            .fontSize(11)
            .text(`${label}: ${value.replace(/[\x00-\x1f\x7f]/g, ' ')}`);
          doc.moveDown(0.5);
        }
        doc.end();
      } catch (error) {
        doc.destroy();
        reject(error);
      }
    });
  }
}
