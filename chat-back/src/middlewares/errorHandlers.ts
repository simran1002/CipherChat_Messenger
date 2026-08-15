import type { NextFunction, Request, RequestHandler, Response } from "express";
import { MulterError } from "multer";
import { HttpError } from "../errors/HttpError.js";
import { logger } from "../utils/logger.js";
import { isDevelopment } from "../config/env.js";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Wrap an async route handler so rejections reach the error middleware. */
export function catchErrors(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ message: "Route not found", code: "route_not_found" });
}

interface MongooseValidationError extends Error {
  errors: Record<string, { message: string }>;
}

function isMongooseValidationError(err: unknown): err is MongooseValidationError {
  return err instanceof Error && "errors" in err && typeof (err as MongooseValidationError).errors === "object";
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express identifies error middleware by arity
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // Operational errors we threw on purpose
  if (err instanceof HttpError) {
    res.status(err.status).json({ message: err.message, code: err.code });
    return;
  }

  // Multer errors (file too large, unexpected field) → 400
  if (err instanceof MulterError) {
    res.status(400).json({ message: err.message, code: `upload_${err.code.toLowerCase()}` });
    return;
  }

  // Mongoose schema validation → 400 with joined field messages
  if (isMongooseValidationError(err)) {
    const message = Object.values(err.errors)
      .map((e) => e.message)
      .join(", ");
    res.status(400).json({ message, code: "validation_error" });
    return;
  }

  // Unexpected — log it (previously these vanished silently in production)
  const error = err instanceof Error ? err : new Error(String(err));
  logger.error("Unhandled error", {
    message: error.message,
    stack: error.stack,
    path: req.path,
    method: req.method,
  });

  if (isDevelopment) {
    res.status(500).json({ message: error.message, stack: error.stack ?? "" });
  } else {
    res.status(500).json({ error: "Internal Server Error" });
  }
}
