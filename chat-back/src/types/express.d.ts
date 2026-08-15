import type { AuthPayload } from "../middlewares/auth.js";

declare global {
  namespace Express {
    interface Request {
      payload?: AuthPayload;
    }
  }
}

export {};
