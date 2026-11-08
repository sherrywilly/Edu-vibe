import { ExamService } from './exam.service';
import { ExamDeadlineWorker } from './exam-deadline.worker';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is required for the deadline worker');
const worker = new ExamDeadlineWorker(new ExamService(), redisUrl);
worker.start();

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void worker.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
