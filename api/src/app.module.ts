import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ExamController } from './exam.controller';
import { ExamService } from './exam.service';

@Module({
  imports: [],
  controllers: [AppController, ExamController],
  providers: [ExamService],
})
export class AppModule {}
