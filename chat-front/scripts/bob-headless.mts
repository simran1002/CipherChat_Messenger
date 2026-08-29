/**
 * Headless "Bob" — protocol-level verification of E2EE DM attachments using
 * the REAL frontend crypto modules in Node (no browser, no IndexedDB).
 *   phase setup : register Bob + publish key bundle (prints identity JSON)
 *   phase verify: poll the conversation, accept the session from the init
 *                 envelope, decrypt content, download + decrypt the blob.
 */
import { generateEd25519, generateX25519, sign, toBase64 } from "../src/crypto/primitives";
import { acceptSession } from "../src/crypto/session";
import { open } from "../src/crypto/envelope";
import { parseDmContent } from "../src/crypto/dmContent";
import { decryptDmFile } from "../src/crypto/fileCrypto";
import fs from "node:fs";

const BASE = "http://localhost:8100";
const STATE = new URL("./bob-state.json", import.meta.url);
const phase = process.argv[2];

async function j(path: string, init?: RequestInit & { token?: string }) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

if (phase === "setup") {
  const email = `attach-bob-${Date.now()}@test.cipher`;
  const reg = await j("/user/register", {
    method: "POST",
    body: JSON.stringify({ name: "Attach Bob", email, password: "password123" }),
  });
  const ed = generateEd25519();
  const x = generateX25519();
  const spk = generateX25519();
  const identity = {
    edPriv: toBase64(ed.privateKey), edPub: toBase64(ed.publicKey),
    xPriv: toBase64(x.privateKey), xPub: toBase64(x.publicKey),
    spkId: 1, spkPriv: toBase64(spk.privateKey), spkPub: toBase64(spk.publicKey),
    createdAt: Date.now(),
  };
  await j("/keys", {
    method: "PUT",
    token: reg.token,
    body: JSON.stringify({
      identityEd25519: identity.edPub,
      identityX25519: identity.xPub,
      signedPreKey: { keyId: 1, pubX25519: identity.spkPub, sig: toBase64(sign(ed.privateKey, spk.publicKey)) },
    }),
  });
  fs.writeFileSync(STATE, JSON.stringify({ token: reg.token, userId: reg.user.id, identity }));
  console.log(JSON.stringify({ phase: "setup", ok: true, bobName: "Attach Bob", bobId: reg.user.id }));
} else if (phase === "verify") {
  const { token, userId, identity } = JSON.parse(fs.readFileSync(STATE, "utf8"));
  // Poll for the conversation + an e2ee message with an init block
  let convId = "", env: any = null, senderId = "";
  for (let i = 0; i < 30 && !env; i++) {
    const convs = await j("/dm", { token });
    for (const c of convs) {
      const hist = await j(`/dm/${c._id}/messages`, { token });
      const row = (hist.messages as any[]).find((m) => m.type === "e2ee/v1" && m.envelope?.init);
      if (row) { convId = c._id; env = row.envelope; senderId = row.userId; break; }
    }
    if (!env) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!env) throw new Error("no e2ee message with init block appeared");

  const session = acceptSession(convId, senderId, env.sessionId, identity, env.init);
  const plaintext = open(session, convId, senderId, env);
  const content = parseDmContent(plaintext);
  if (content.t !== "file") throw new Error("expected file content, got: " + plaintext.slice(0, 80));

  const blobRes = await fetch(content.file.url.startsWith("http") ? content.file.url : BASE + content.file.url);
  const cipher = await blobRes.arrayBuffer();
  const fileBlob = await decryptDmFile(content.file, cipher);
  const text = Buffer.from(await fileBlob.arrayBuffer()).toString("utf8");
  console.log(JSON.stringify({
    phase: "verify", ok: true,
    conversationId: convId, sessionId: env.sessionId, ctr: env.ctr,
    fileName: content.file.name, mime: content.file.mime, size: content.file.size,
    cipherBytes: cipher.byteLength, decryptedText: text,
  }));
} else {
  throw new Error("usage: tsx bob-headless.mts setup|verify");
}
