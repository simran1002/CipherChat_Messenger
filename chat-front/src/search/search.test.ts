import { describe, expect, it } from "vitest";
import { SearchCore, type SearchDoc } from "./searchCore";
import { generateSnapshotKey, openSnapshot, sealSnapshot } from "./snapshotCrypto";

const docs: SearchDoc[] = [
  { id: "1", convId: "c-legal", sender: "Priya", text: "The subpoena response is due Friday", ts: 1000 },
  { id: "2", convId: "c-legal", sender: "Marcus", text: "I will draft the motion to quash tonight", ts: 2000 },
  { id: "3", convId: "c-news", sender: "Elena", text: "Source confirmed the subpoena was served", ts: 3000 },
  { id: "4", convId: "c-news", sender: "Elena", text: "Lunch at noon?", ts: 4000 },
];

describe("SearchCore", () => {
  it("finds messages by word, across conversations, newest first on equal score", async () => {
    const core = await SearchCore.create();
    await core.addAll(docs);
    const hits = await core.search("subpoena");
    expect(hits.map((h) => h.id).sort()).toEqual(["1", "3"]);
  });

  it("filters by conversation", async () => {
    const core = await SearchCore.create();
    await core.addAll(docs);
    expect((await core.search("subpoena", { convId: "c-news" })).map((h) => h.id)).toEqual(["3"]);
  });

  it("tolerates a typo and stems word forms", async () => {
    const core = await SearchCore.create();
    await core.addAll(docs);
    expect((await core.search("subpena")).length).toBe(2);           // edit distance 1
    expect((await core.search("drafting")).map((h) => h.id)).toEqual(["2"]); // draft / drafting
  });

  it("dedupes on id, re-indexes on edit, and removes on delete", async () => {
    const core = await SearchCore.create();
    await core.addAll(docs);
    expect(await core.add(docs[0]!)).toBe(false);
    expect(await core.add({ ...docs[3]!, text: "Dinner at eight?" })).toBe(true);
    expect((await core.search("lunch")).length).toBe(0);
    expect((await core.search("dinner")).map((h) => h.id)).toEqual(["4"]);
    expect(await core.delete("4")).toBe(true);
    expect((await core.search("dinner")).length).toBe(0);
    expect(core.size).toBe(3);
  });

  it("shredding a conversation removes every one of its documents", async () => {
    const core = await SearchCore.create();
    await core.addAll(docs);
    expect(await core.deleteConversation("c-legal")).toBe(2);
    expect((await core.search("subpoena")).map((h) => h.id)).toEqual(["3"]);
    expect(core.conversations()).toEqual(["c-news"]);
  });
});

describe("snapshot encryption", () => {
  it("round-trips a conversation's docs and hides the plaintext", async () => {
    const key = await generateSnapshotKey();
    const legal = docs.filter((d) => d.convId === "c-legal");
    const sealed = await sealSnapshot(key, "c-legal", legal);
    expect(new TextDecoder().decode(sealed.blob)).not.toContain("subpoena");
    expect(await openSnapshot(key, sealed)).toEqual(legal);
  });

  it("rejects a blob moved under another conversation, a flipped byte, and the wrong key", async () => {
    const key = await generateSnapshotKey();
    const sealed = await sealSnapshot(key, "c-legal", docs.slice(0, 2));
    await expect(openSnapshot(key, { ...sealed, convId: "c-news" })).rejects.toThrow();
    const tampered = { ...sealed, blob: Uint8Array.from(sealed.blob) };
    tampered.blob[5] = tampered.blob[5]! ^ 0xff;
    await expect(openSnapshot(key, tampered)).rejects.toThrow();
    await expect(openSnapshot(await generateSnapshotKey(), sealed)).rejects.toThrow();
  });
});
