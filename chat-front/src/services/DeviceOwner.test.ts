import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wipeKeyStore = vi.fn().mockResolvedValue(undefined);
const wipeVault = vi.fn().mockResolvedValue(undefined);
const wipeSearchIndex = vi.fn().mockResolvedValue(undefined);
const clearQueue = vi.fn().mockResolvedValue(undefined);

vi.mock("../crypto/keyStore", () => ({ wipeKeyStore: () => wipeKeyStore() }));
vi.mock("../crypto/vault", () => ({ wipeVault: () => wipeVault() }));
vi.mock("../search/searchClient", () => ({ wipeSearchIndex: () => wipeSearchIndex() }));
vi.mock("./OfflineQueue", () => ({ clear: () => clearQueue() }));

import { claim } from "./DeviceOwner";

describe("DeviceOwner", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => localStorage.clear());

  it("a fresh browser records the first account without wiping anything", async () => {
    await claim("user-a");

    expect(wipeKeyStore).not.toHaveBeenCalled();
    expect(wipeVault).not.toHaveBeenCalled();
    expect(wipeSearchIndex).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
    expect(localStorage.getItem("CC_DeviceOwner")).toBe("user-a");
  });

  it("the same account signing back in is a no-op — local history and keys survive", async () => {
    await claim("user-a");
    vi.clearAllMocks();

    await claim("user-a");

    expect(wipeKeyStore).not.toHaveBeenCalled();
    expect(wipeVault).not.toHaveBeenCalled();
    expect(wipeSearchIndex).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
  });

  it("a different account on this browser wipes every local E2EE store and the offline queue", async () => {
    await claim("user-a");
    vi.clearAllMocks();

    await claim("user-b");

    expect(wipeKeyStore).toHaveBeenCalledTimes(1);
    expect(wipeVault).toHaveBeenCalledTimes(1);
    expect(wipeSearchIndex).toHaveBeenCalledTimes(1);
    expect(clearQueue).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("CC_DeviceOwner")).toBe("user-b");
  });

  it("switching back to the first account again wipes account b's leftovers in turn", async () => {
    await claim("user-a");
    await claim("user-b");
    vi.clearAllMocks();

    await claim("user-a");

    expect(wipeKeyStore).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("CC_DeviceOwner")).toBe("user-a");
  });
});
