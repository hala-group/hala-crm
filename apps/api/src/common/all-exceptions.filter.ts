import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { errorDiagnostics } from './error-diagnostics.js';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const status = error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    if (status >= 500) this.logger.error({ ...errorDiagnostics(error), method: request.method,
      route: request.route?.path ?? 'unmatched' }, 'Request failed');
    const message = error instanceof HttpException ? error.message : 'Internal server error';
    const detail = error instanceof HttpException ? error.getResponse() : null;
    const extra = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail as Record<string, unknown> : {};
    response.status(status).json({ statusCode: status, message, path: request.url, ...extra });
  }
}
