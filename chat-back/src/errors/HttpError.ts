/**
 * Typed operational error. Replaces the legacy `throw "string"` idiom:
 * carries an HTTP status, a stable machine-readable code, and a stack trace.
 * Anything that is NOT an HttpError is treated as an unexpected 500.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    Error.captureStackTrace?.(this, HttpError);
  }

  static badRequest(message: string, code = "bad_request"): HttpError {
    return new HttpError(400, code, message);
  }

  static unauthorized(message = "Authentication required", code = "unauthorized"): HttpError {
    return new HttpError(401, code, message);
  }

  static forbidden(message = "Forbidden", code = "forbidden"): HttpError {
    return new HttpError(403, code, message);
  }

  static notFound(message: string, code = "not_found"): HttpError {
    return new HttpError(404, code, message);
  }

  static conflict(message: string, code = "conflict"): HttpError {
    return new HttpError(409, code, message);
  }
}
