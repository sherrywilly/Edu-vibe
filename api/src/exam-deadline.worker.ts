import { Logger } from '@nestjs/common';
import { DelayedError, Job, Queue, Worker } from 'bullmq';
import { ExamService } from './exam.service';
import { HealthProbe } from './health-probe';

const QUEUE_NAME = 'exam-deadlines';
const INTERVAL_MS = 30_000;
const DATABASE_HEARTBEAT_MAX_AGE_MS = INTERVAL_MS * 3;

export class ExamDeadlineWorker {
  private readonly logger = new Logger(ExamDeadlineWorker.name);
  private readonly queue: Queue<{ attemptId: string }>;
  private readonly worker: Worker<{ attemptId: string }>;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private sweeping?: Promise<void>;
  private stopping = false;
  private workerReady = false;
  private lastDatabaseSuccess = 0;
  private readonly redisHealth: HealthProbe;
  private lastRedisWarning = 0;
  private stopReconciliation!: () => void;
  private readonly stopSignal = new Promise<void>((resolve) => {
    this.stopReconciliation = resolve;
  });

  constructor(
    private readonly service: ExamService,
    redisUrl: string,
  ) {
    const url = new URL(redisUrl);
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:')
      throw new Error('Invalid Redis URL');
    const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
    if (!Number.isInteger(db) || db < 0)
      throw new Error('Invalid Redis database');
    const connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
      db,
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    };
    this.queue = new Queue(QUEUE_NAME, {
      connection: {
        ...connection,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      },
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
    this.worker = new Worker(
      QUEUE_NAME,
      (job, token) => this.process(job, token),
      {
        connection: { ...connection, maxRetriesPerRequest: null },
      },
    );
    this.queue.on('error', () => this.warnRedisUnavailable());
    this.worker.on('error', () => {
      this.workerReady = false;
      this.warnRedisUnavailable();
    });
    this.worker.on('ready', () => {
      this.workerReady = true;
    });
    this.worker.on('ioredis:close', () => {
      this.workerReady = false;
    });
    this.worker.on('failed', () => this.logger.warn('Deadline job failed'));
    this.redisHealth = new HealthProbe(async () => {
      const blockingClient = this.worker.getBackend().blockingClient;
      if (!blockingClient) return false;
      const [queueClient, workerClient, blocking] = await Promise.all([
        this.queue.getBackend().client,
        this.worker.getBackend().client,
        blockingClient,
      ]);
      const ready = () =>
        [queueClient, workerClient, blocking].every(
          (client) => client.status === 'ready',
        );
      if (!ready()) return false;
      const writes = await Promise.allSettled([
        queueClient.set(this.queue.toKey('health-check:queue'), '1', { EX: 10 }),
        workerClient.set(this.queue.toKey('health-check:worker'), '1', {
          EX: 10,
        }),
      ]);
      return (
        ready() &&
        writes.every(
          (write) => write.status === 'fulfilled' && write.value === 'OK',
        )
      );
    });
  }

  async health(): Promise<{ database: boolean; redis: boolean }> {
    const active = () =>
      !this.stopping &&
      !!this.timer &&
      this.worker.isRunning() &&
      !this.worker.isPaused();
    const redis = active() && (await this.redisHealth.run()) && active();
    return {
      database:
        !this.stopping &&
        !!this.timer &&
        this.lastDatabaseSuccess > 0 &&
        Date.now() - this.lastDatabaseSuccess < DATABASE_HEARTBEAT_MAX_AGE_MS,
      redis,
    };
  }

  private warnRedisUnavailable() {
    if (Date.now() - this.lastRedisWarning < INTERVAL_MS) return;
    this.lastRedisWarning = Date.now();
    this.logger.warn('Deadline Redis connection unavailable');
  }

  async process(job: Job<{ attemptId: string }>, token?: string) {
    const result = await this.service.finalizeDue(job.data.attemptId);
    if (result) {
      if (!token) throw new Error('Deadline job lock unavailable');
      await job.moveToDelayed(
        Date.now() + Math.max(1, result.remainingMs),
        token,
      );
      throw new DelayedError();
    }
  }

  start() {
    if (this.timer || this.stopping) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
    this.timer.unref();
  }

  private tick() {
    if (this.stopping) return;
    if (!this.sweeping) {
      this.sweeping = this.service
        .sweep()
        .catch(() => this.logger.warn('Exam recovery sweep failed'))
        .finally(() => {
          this.sweeping = undefined;
        });
    }
    if (!this.running)
      this.running = this.reconcile().finally(() => {
        this.running = undefined;
      });
  }

  async reconcile() {
    try {
      let after: string | undefined;
      while (!this.stopping) {
        let attempts: Awaited<ReturnType<ExamService['pendingDeadlines']>>;
        try {
          attempts = await this.service.pendingDeadlines(after);
          this.lastDatabaseSuccess = Date.now();
        } catch (error) {
          this.lastDatabaseSuccess = 0;
          throw error;
        }
        for (const attempt of attempts) {
          if (this.stopping) return;
          await Promise.race([
            this.queue.add(
              'finalize',
              { attemptId: attempt.id },
              { jobId: attempt.id, delay: attempt.remainingMs },
            ),
            this.stopSignal,
          ]);
        }
        if (attempts.length < 100) break;
        after = attempts[attempts.length - 1].id;
      }
    } catch {
      this.logger.warn('Deadline reconciliation failed; recovery will retry');
    }
  }

  async close() {
    this.stopping = true;
    this.stopReconciliation();
    if (this.timer) clearInterval(this.timer);
    await this.queue.close();
    await this.worker.close(!this.workerReady);
    await this.running;
    await this.sweeping;
    await this.service.onModuleDestroy();
  }
}
