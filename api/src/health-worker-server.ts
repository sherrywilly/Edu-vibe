import { createServer, Server } from 'node:http';
import { ExamDeadlineWorker } from './exam-deadline.worker';

export function createWorkerHealthServer(worker: ExamDeadlineWorker): Server {
  return createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') {
      response.writeHead(404).end();
      return;
    }
    void worker.health().then(
      (health) => {
        const ok = health.database && health.redis;
        response.writeHead(ok ? 200 : 503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        response.end(
          JSON.stringify({ status: ok ? 'ok' : 'unavailable', ...health }),
        );
      },
      () => {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: 'unavailable' }));
      },
    );
  });
}
