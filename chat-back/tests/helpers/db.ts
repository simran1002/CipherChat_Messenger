import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

let mongod: MongoMemoryServer | null = null;

/** Start an isolated in-memory MongoDB and point mongoose at it. */
export async function startDb(): Promise<void> {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("cipherchat_test"));
}

/** Drop everything and shut the in-memory server down. */
export async function stopDb(): Promise<void> {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
}

/** Wipe all collections between tests without restarting the server. */
export async function resetDb(): Promise<void> {
  const collections = await mongoose.connection.db?.collections();
  if (!collections) return;
  await Promise.all(collections.map((c) => c.deleteMany({})));
}
