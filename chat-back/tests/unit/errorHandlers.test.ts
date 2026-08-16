import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { catchErrors, errorHandler } from "../../src/middlewares/errorHandlers.js";
import { HttpError } from "../../src/errors/HttpError.js";

/**
 * Throwaway express app that exercises each branch of the error pipeline.
 * setupEnv sets ENV=TEST, so isDevelopment is false and unexpected errors
 * must NOT leak messages or stack traces.
 */
function buildApp(): express.Express {
  const app = express();

  app.get("/http-error", () => {
    throw HttpError.notFound("Widget not found", "widget_missing");
  });

  app.get("/generic-error", () => {
    throw new Error("secret internal detail");
  });

  app.get(
    "/async-rejection",
    catchErrors(async () => {
      throw new Error("async secret detail");
    })
  );

  app.get("/validation-error", (_req, _res, next) => {
    // Mongoose-style ValidationError shape: Error with an `errors` map
    const err = new Error("Validation failed") as Error & {
      errors: Record<string, { message: string }>;
    };
    err.errors = {
      name: { message: "Name is required" },
      email: { message: "Email is invalid" },
    };
    next(err);
  });

  app.use(errorHandler);
  return app;
}

describe("errorHandlers middleware", () => {
  let server: HttpServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = buildApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("maps HttpError to its status with message and code", async () => {
    const res = await fetch(`${baseUrl}/http-error`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Widget not found", code: "widget_missing" });
  });

  it("maps a generic Error to an opaque 500 (no leaked details outside development)", async () => {
    const res = await fetch(`${baseUrl}/generic-error`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "Internal Server Error" });
    expect(JSON.stringify(body)).not.toContain("secret internal detail");
  });

  it("routes async rejections through catchErrors to the error middleware", async () => {
    const res = await fetch(`${baseUrl}/async-rejection`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal Server Error" });
  });

  it("maps a mongoose-style validation error to 400 with joined field messages", async () => {
    const res = await fetch(`${baseUrl}/validation-error`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      message: "Name is required, Email is invalid",
      code: "validation_error",
    });
  });
});
