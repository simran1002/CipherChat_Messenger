// Detects patterns that look like passwords, OTPs, credit cards, API keys, etc.
// Returns null if clean, or an object { type, suggestion } if sensitive content found.

export interface SensitiveMatch {
  type: string;
  suggestion: string;
}

interface SensitivePattern extends SensitiveMatch {
  regex: RegExp;
}

const PATTERNS: SensitivePattern[] = [
  {
    type: "OTP / Verification code",
    // Digits and the keyword in EITHER order — "123456 is your OTP" and
    // "Your OTP is 123456" both match (the old pattern only caught the first)
    regex: /\b\d{4,8}\b[\s\S]{0,40}\b(?:otp|code|verify|verification|pin|token)\b|\b(?:otp|code|verify|verification|pin|token)\b[\s\S]{0,40}\b\d{4,8}\b/i,
    suggestion: "Sharing OTPs can compromise your account. Consider calling instead.",
  },
  {
    type: "Credit card number",
    regex: /\b(?:\d[ -]?){13,16}\b/,
    suggestion: "This looks like a credit card number. Never share card details in chat.",
  },
  {
    type: "Password",
    regex: /(?:password|passwd|pwd)\s*[:=]\s*\S+/i,
    suggestion: "Avoid sharing passwords in chat — use a password manager instead.",
  },
  {
    type: "API key",
    // Labeled keys (api_key=…) OR bare well-known key shapes: sk-/pk- prefixed
    // provider keys, GitHub gh[pousr]_…, AWS AKIA…, Slack xox…, generic Bearer tokens
    regex:
      /(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*\S{16,}|\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
    suggestion: "API keys should never be shared in chat — revoke and rotate it immediately.",
  },
  {
    type: "Phone number",
    regex: /\b(?:\+91|0)?[6-9]\d{9}\b|\b\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/,
    suggestion: "You're about to share a phone number. Make sure the recipient should have it.",
  },
  {
    type: "Email address",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
    suggestion: "You're sharing an email address — confirm the recipient should have this.",
  },
];

export const detectSensitiveData = (text: string | null | undefined): SensitiveMatch | null => {
  if (!text || text.length < 4) return null;
  for (const p of PATTERNS) {
    if (p.regex.test(text)) return { type: p.type, suggestion: p.suggestion };
  }
  return null;
};

export default detectSensitiveData;
