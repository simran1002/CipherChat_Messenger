import "@testing-library/jest-dom";

// jsdom has no WebCrypto — use Node's implementation (same standard API)
import { webcrypto } from "node:crypto";
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

