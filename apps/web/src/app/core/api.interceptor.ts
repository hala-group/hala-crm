import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import { inject } from '@angular/core';
import { from, switchMap } from 'rxjs';
import { AuthStore } from './auth.store';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

let refreshInFlight: Promise<string> | null = null;

export const apiInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthStore);
  const isAuthRequest = /\/auth\/(login|refresh|accept-invite)$/.test(request.url);
  const token = auth.accessToken();
  const authorized = token && !isAuthRequest ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : request;
  return next(authorized).pipe(
    catchError(error => {
      if (error instanceof HttpErrorResponse && error.status === 401 && !isAuthRequest && !request.url.endsWith('/auth/logout')) {
        refreshInFlight ??= auth.refresh().finally(() => { refreshInFlight = null; });
        return from(refreshInFlight).pipe(
          switchMap(newToken => next(request.clone({ setHeaders: { Authorization: `Bearer ${newToken}` } })))
        );
      }
      if (error instanceof HttpErrorResponse) {
        const body = error.error as unknown;
        const message =
          typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string'
            ? body.message
            : error.message;
        return throwError(() => new ApiError(error.status, message));
      }
      return throwError(() => error);
    })
  );
};
