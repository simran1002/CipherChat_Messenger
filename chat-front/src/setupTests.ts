import "@testing-library/jest-dom";

// Always use Node's WebCrypto in tests. jsdom ships its own partial `crypto`
// (so a "missing subtle" guard never fires), but its webidl layer rejects
// ArrayBuffers created in the test realm — Node's implementation is complete
// (AES-GCM, HKDF, HMAC, X25519 on Node 20) and realm-agnostic here.
import { webcrypto } from "node:crypto";
Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
