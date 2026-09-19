/**
 * Client-side PII redaction for text that is about to leave the device for an LLM.
 *
 * redact() replaces detected entities with stable placeholder tokens ([PERSON_1], [EMAIL_2], …)
 * and returns the token → original map. The map NEVER leaves the browser: the server and the
 * model see only tokens, and rehydrate() puts the originals back into the model's answer.
 *
 * Detection is deliberately conservative and deterministic:
 *   - structured identifiers by pattern (email, phone, card with Luhn, government ids, MRN, IP, URL)
 *   - person names from a caller-supplied dictionary (the room roster / DM peer), longest first
 * Free-text names outside the roster are NOT detected — that needs an NER model and is listed as
 * a known limit. The server runs an independent second line and fails closed (422) on a miss.
 */

export const PII_POLICY_VERSION = "pii-2026.09";

export type EntityType = "PERSON" | "EMAIL" | "PHONE" | "CARD" | "GOV_ID" | "MRN" | "IP" | "URL";

export interface RedactionResult {
  text: string;
  /** token → original value. Keep in memory only. */
  map: Map<string, string>;
  counts: Record<EntityType, number>;
}

export interface RedactorOptions {
  /** Known person names (room members, DM peer). Matched case-insensitively on word boundaries. */
  names?: string[];
}

const TOKEN = /\[(PERSON|EMAIL|PHONE|CARD|GOV_ID|MRN|IP|URL)_(\d+)\]/g;

interface Detector {
  type: EntityType;
  regex: RegExp;
  accept?: (match: string) => boolean;
}

export function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

// Order matters: the most specific shapes run first so a card number is not half-eaten as a phone.
const DETECTORS: Detector[] = [
  { type: "EMAIL", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: "URL", regex: /\bhttps?:\/\/[^\s<>()"']+/g },
  { type: "CARD", regex: /\b(?:\d[ -]?){12,18}\d\b/g, accept: luhnValid },
  // US SSN, Indian Aadhaar (4-4-4), Indian PAN
  { type: "GOV_ID", regex: /\b\d{3}-\d{2}-\d{4}\b|\b\d{4}\s\d{4}\s\d{4}\b|\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { type: "MRN", regex: /\b(?:MRN|UHID|Patient\s?ID)\s*[:#-]?\s*[A-Z0-9-]{4,}\b/gi },
  { type: "IP", regex: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  { type: "PHONE", regex: /(?<![\w.])\+?\d[\d\s().-]{8,16}\d(?!\w|\.\d)/g, accept: (m) => m.replace(/\D/g, "").length >= 10 },
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One redaction session: the same value always maps to the same token across calls. */
export class PiiRedactor {
  private readonly byValue = new Map<string, string>();
  private readonly map = new Map<string, string>();
  private readonly counters = new Map<EntityType, number>();
  private readonly nameRegex: RegExp | null;

  constructor(options: RedactorOptions = {}) {
    const names = [...new Set((options.names ?? []).map((n) => n.trim()).filter((n) => n.length >= 2))]
      // full names first, then their parts, longest first so "Anika Rao" wins over "Anika"
      .flatMap((n) => [n, ...n.split(/\s+/).filter((p) => p.length >= 3)])
      .sort((a, b) => b.length - a.length);
    this.nameRegex = names.length
      ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${[...new Set(names)].map(escapeRegex).join("|")})(?![\\p{L}\\p{N}_])`, "giu")
      : null;
  }

  private tokenFor(type: EntityType, value: string): string {
    const key = `${type}:${type === "PERSON" || type === "EMAIL" ? value.toLowerCase() : value}`;
    const existing = this.byValue.get(key);
    if (existing) return existing;
    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    const token = `[${type}_${n}]`;
    this.byValue.set(key, token);
    this.map.set(token, value);
    return token;
  }

  redact(input: string): string {
    let text = input;
    for (const d of DETECTORS) {
      text = text.replace(d.regex, (m) => (d.accept && !d.accept(m) ? m : this.tokenFor(d.type, m)));
    }
    if (this.nameRegex) {
      text = text.replace(this.nameRegex, (m) => this.tokenFor("PERSON", m));
    }
    return text;
  }

  result(text: string): RedactionResult {
    const counts = { PERSON: 0, EMAIL: 0, PHONE: 0, CARD: 0, GOV_ID: 0, MRN: 0, IP: 0, URL: 0 } as Record<EntityType, number>;
    for (const [type, n] of this.counters) counts[type] = n;
    return { text, map: new Map(this.map), counts };
  }

  tokenMap(): Map<string, string> {
    return new Map(this.map);
  }

  entityCounts(): Record<EntityType, number> {
    return this.result("").counts;
  }
}

/** Convenience for a single string. */
export function redact(input: string, options: RedactorOptions = {}): RedactionResult {
  const r = new PiiRedactor(options);
  return r.result(r.redact(input));
}

/** Replace tokens in model output with their originals. Unknown tokens are left as they are. */
export function rehydrate(text: string, map: Map<string, string>): string {
  return text.replace(TOKEN, (token) => map.get(token) ?? token);
}

/** True when the text still contains anything a detector recognises (used as a client-side assert). */
export function containsPii(text: string): EntityType[] {
  const hits = new Set<EntityType>();
  for (const d of DETECTORS) {
    d.regex.lastIndex = 0;
    for (const m of text.matchAll(d.regex)) {
      if (!d.accept || d.accept(m[0])) hits.add(d.type);
    }
  }
  return [...hits];
}
