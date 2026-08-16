/**
 * Safety number: a 60-digit fingerprint of both parties' identity keys
 * (Signal's presentation format). Both clients compute the same number; if
 * users compare it out-of-band and it matches, no MITM key substitution has
 * happened — including by the server operator.
 */
import { concatBytes, fromBase64, hashSha512, utf8Encode } from "./primitives";

function fingerprintHalf(userId: string, identityEd25519B64: string): Uint8Array {
  // 5200 SHA-512 iterations (Signal's constant) — makes brute-forcing a
  // partial-match key prohibitively expensive.
  let data = concatBytes(utf8Encode(userId), fromBase64(identityEd25519B64));
  for (let i = 0; i < 5200; i++) {
    data = hashSha512(data);
  }
  return data;
}

function digitsFrom(hash: Uint8Array): string {
  // 6 groups of 5 digits from successive 40-bit windows
  let out = "";
  for (let g = 0; g < 6; g++) {
    const o = g * 5;
    const chunk =
      hash[o]! * 2 ** 32 + hash[o + 1]! * 2 ** 24 + hash[o + 2]! * 2 ** 16 + hash[o + 3]! * 2 ** 8 + hash[o + 4]!;
    out += String(chunk % 100000).padStart(5, "0");
  }
  return out;
}

/** 60 decimal digits, 12 groups of 5, sorted so both sides render identically. */
export function computeSafetyNumber(
  myUserId: string,
  myIdentityEd25519: string,
  peerUserId: string,
  peerIdentityEd25519: string
): string {
  const mine = digitsFrom(fingerprintHalf(myUserId, myIdentityEd25519));
  const theirs = digitsFrom(fingerprintHalf(peerUserId, peerIdentityEd25519));
  const [first, second] = [mine, theirs].sort();
  return `${first}${second}`;
}

/** Human display: "12345 67890 …" in 12 groups. */
export function formatSafetyNumber(digits: string): string {
  return digits.match(/.{1,5}/g)?.join(" ") ?? digits;
}
