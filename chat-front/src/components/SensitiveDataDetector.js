// Detects patterns that look like passwords, OTPs, credit cards, API keys, etc.
// Returns null if clean, or an object { type, suggestion } if sensitive content found.

const PATTERNS = [
  {
    type: "OTP / Verification code",
    regex: /\b(\d{4,8})\b.*(?:otp|code|verify|pin|token)/i,
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
    regex: /(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*\S{16,}/i,
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

export const detectSensitiveData = (text) => {
  if (!text || text.length < 4) return null;
  for (const p of PATTERNS) {
    if (p.regex.test(text)) return { type: p.type, suggestion: p.suggestion };
  }
  return null;
};

export default detectSensitiveData;
