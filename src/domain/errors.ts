export type ErrorOptions = {
  retryable?: boolean | undefined;
  statusCode?: number | undefined;
  details?: Record<string, unknown> | undefined;
  cause?: unknown;
};

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  readonly code = "VALIDATION_ERROR";
  readonly statusCode = 400;

  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(message, { retryable: false, details, cause });
  }
}

export class AuthError extends AppError {
  readonly code = "UNAUTHORIZED";
  readonly statusCode = 401;

  constructor(message = "Unauthorized request", details?: Record<string, unknown>) {
    super(message, { retryable: false, details });
  }
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  readonly statusCode = 404;

  constructor(resource: string, details?: Record<string, unknown>) {
    super(`${resource} not found`, { retryable: false, details });
  }
}

export class ConflictError extends AppError {
  readonly code = "CONFLICT";
  readonly statusCode = 409;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { retryable: false, details });
  }
}

export class LimitExceededError extends AppError {
  readonly code = "LIMIT_EXCEEDED";
  readonly statusCode = 429;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { retryable: false, details });
  }
}

export class RpcError extends AppError {
  readonly code = "RPC_ERROR";
  readonly statusCode: number;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.statusCode = options?.statusCode ?? 502;
  }
}

export class NotifierError extends AppError {
  readonly code = "NOTIFIER_ERROR";
  readonly statusCode = 502;
  readonly channel: string;
  readonly retryAfterMs: number | undefined;

  constructor(
    channel: string,
    message: string,
    options?: ErrorOptions & { retryAfterMs?: number | undefined },
  ) {
    super(message, options);
    this.channel = channel;
    this.retryAfterMs = options?.retryAfterMs;
  }
}
