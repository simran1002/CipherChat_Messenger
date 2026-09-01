/**
 * RAM-backed MongoDB for benchmarking (mongodb-memory-server, port 27099).
 * Keeps free-tier Atlas connection throttling out of connection-density
 * measurements — the first 10k run melted the shared cluster with per-connect
 * bookkeeping writes and measured the database plan, not the server.
 * Ctrl-C to stop.
 */
import { MongoMemoryServer } from "mongodb-memory-server";

const mongod = await MongoMemoryServer.create({ instance: { port: 27099, ip: "127.0.0.1" } });
console.log(`bench mongod up: ${mongod.getUri()} — Ctrl-C to stop`);
setInterval(() => {}, 60_000); // keep alive
