import { Module } from '@nestjs/common';
import { QuestionImportController } from './question-import.controller';
import { QuestionImportService } from './question-import.service';

@Module({
  controllers: [QuestionImportController],
  providers: [QuestionImportService],
})
export class QuestionImportModule {}
