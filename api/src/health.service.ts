import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { HealthProbe } from './health-probe';

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly db = new PrismaClient();
  private readonly database = new HealthProbe(async () => {
    await this.db.$queryRaw`SELECT 1`;
    return true;
  });

  ready(): Promise<boolean> {
    return this.database.run();
  }

  async onModuleDestroy() {
    await this.db.$disconnect();
  }
}
