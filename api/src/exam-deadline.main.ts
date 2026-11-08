import { ExamService } from './exam.service';
import { ExamDeadlineWorker } from './exam-deadline.worker';
import { createWorkerHealthServer } from './health-worker-server';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is required for the deadline worker');
const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 4001);
if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65535)
  throw new Error('Invalid WORKER_HEALTH_PORT');
const worker = new ExamDeadlineWorker(new ExamService(), redisUrl);
const healthServer = createWorkerHealthServer(worker);
healthServer.listen(healthPort, '0.0.0.0');
worker.start();

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  const closingWorker = worker.close();
  const closingServer = new Promise<void>((resolve, reject) => {
    healthServer.close((error) => (error ? reject(error) : resolve()));
  });
  void Promise.all([closingWorker, closingServer]).then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
