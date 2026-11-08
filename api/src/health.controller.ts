import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('ready')
  async ready() {
    if (!(await this.health.ready())) {
      throw new ServiceUnavailableException('Not ready');
    }
    return { status: 'ok' };
  }
}
