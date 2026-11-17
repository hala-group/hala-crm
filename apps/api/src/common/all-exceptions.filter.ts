import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const status = error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = error instanceof HttpException ? error.message : 'Internal server error';
    const detail = error instanceof HttpException ? error.getResponse() : null;
    const extra = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail as Record<string, unknown> : {};
    response.status(status).json({ statusCode: status, message, path: request.url, ...extra });
  }
}
