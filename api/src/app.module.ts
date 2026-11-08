import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ExamController } from './exam.controller';
import { ExamService } from './exam.service';
import { OptionsController } from './options.controller';
import { LocationController } from './location.controller';
import { LocationService } from './location.service';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { QuestionImportModule } from './question-import.module';
import { AttemptNotesController } from './attempt-notes.controller';
import { AttemptNotesService } from './attempt-notes.service';
import { HealthModule } from './health.module';

@Module({
  imports: [QuestionImportModule, HealthModule],
  controllers: [
    AppController,
    ExamController,
    OptionsController,
    LocationController,
    ImportController,
    ExportController,
    AttemptNotesController,
  ],
  providers: [ExamService, LocationService, ImportService, ExportService, AttemptNotesService],
})
export class AppModule {}
