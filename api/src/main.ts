import { NestFactory } from '@nestjs/core';
import { RuntimeConfigError, validateRuntimeConfig } from './runtime-config';
import { securityHeaders } from './runtime-config-http';

async function bootstrap() {
  try {
    validateRuntimeConfig();
  } catch (error) {
    if (!(error instanceof RuntimeConfigError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule);
  app.use(securityHeaders);
  app.setGlobalPrefix('api');
  await app.listen(process.env.PORT ?? 4000, '0.0.0.0');
}
void bootstrap();
