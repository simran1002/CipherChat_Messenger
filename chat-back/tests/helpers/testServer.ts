/**
 * Boots the real Express app + Socket.IO server on an ephemeral port against
 * whatever mongoose connection the suite established (see db.ts).
 * Returns the base URL plus helpers to mint users/tokens and connect
 * authenticated socket.io clients.
 */
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import bcrypt from "bcryptjs";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

// Import order matters: models must register before app/sockets load.
import "../../src/models/User.js";
import "../../src/models/Chatroom.js";
import "../../src/models/Message.js";
import "../../src/models/DirectMessage.js";
import "../../src/models/DMMessage.js";
import "../../src/models/RefreshToken.js";

import app, { allowedOrigins } from "../../src/app.js";
import { createSocketServer } from "../../src/sockets/index.js";
import { signToken } from "../../src/middlewares/auth.js";
import { User } from "../../src/models/User.js";
import type { AppServer } from "../../src/sockets/events.js";

export interface TestServer {
  baseUrl: string;
  httpServer: HttpServer;
  io: AppServer;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const httpServer = app.listen(0);
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const { port } = httpServer.address() as AddressInfo;
  const io = createSocketServer(httpServer, allowedOrigins);

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    httpServer,
    io,
    close: async () => {
      // io.close() also closes the HTTP server it is attached to; the extra
      // close is only a safety net and may report "not running".
      await io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

let userCounter = 0;

/** Create a user directly in the DB and return an access token for them. */
export async function createUserWithToken(
  name = `Test User ${++userCounter}`
): Promise<{ userId: string; token: string; name: string }> {
  const user = await User.create({
    name,
    email: `user${userCounter}-${Date.now()}@test.cipher`,
    password: await bcrypt.hash("password123", 4),
  });
  return { userId: user.id as string, token: signToken({ id: user.id as string }), name };
}

/** Open an authenticated socket.io client and wait for the connection. */
export function connectClient(baseUrl: string, token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
      timeout: 5000,
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => reject(err));
  });
}
