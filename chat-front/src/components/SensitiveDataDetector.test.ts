import { describe, expect, it } from "vitest";
import { detectSensitiveData } from "./SensitiveDataDetector";

describe("detectSensitiveData", () => {
  it("detects a 16-digit credit card number", () => {
    const match = detectSensitiveData("my card is 4111 1111 1111 1111 ok");
    expect(match).not.toBeNull();
    expect(match?.type).toBe("Credit card number");
    expect(match?.suggestion).toContain("credit card");
  });

  it("detects a 6-digit OTP in either phrasing order", () => {
    const digitsFirst = detectSensitiveData("123456 is your OTP, do not share it");
    expect(digitsFirst?.type).toBe("OTP / Verification code");

    // The common phrasing puts the keyword first — a past pattern missed this
    const keywordFirst = detectSensitiveData("Your OTP is 123456");
    expect(keywordFirst?.type).toBe("OTP / Verification code");

    const verification = detectSensitiveData("verification code: 9482");
    expect(verification?.type).toBe("OTP / Verification code");
  });

  it("detects a password disclosure", () => {
    const match = detectSensitiveData("password: hunter2");
    expect(match).not.toBeNull();
    expect(match?.type).toBe("Password");
    expect(match?.suggestion).toContain("password manager");
  });

  it("detects labeled and bare API keys", () => {
    const labeled = detectSensitiveData("api_key=sk-abc123def456ghi789jkl");
    expect(labeled?.type).toBe("API key");
    expect(labeled?.suggestion).toContain("revoke");

    // Bare pastes of well-known key shapes (no label) must also trip it
    expect(detectSensitiveData("here you go sk-abc123def456ghi789jklmno")?.type).toBe("API key");
    expect(detectSensitiveData("use ghp_abcdefghijklmnopqrstuv123456")?.type).toBe("API key");
    expect(detectSensitiveData("creds AKIAIOSFODNN7EXAMPLE done")?.type).toBe("API key");
  });

  it("detects an email address", () => {
    const match = detectSensitiveData("reach me at alice@example.com anytime");
    expect(match).not.toBeNull();
    expect(match?.type).toBe("Email address");
    expect(match?.suggestion).toContain("email address");
  });

  it("detects a phone number", () => {
    const match = detectSensitiveData("call me on 9876543210 later");
    expect(match).not.toBeNull();
    expect(match?.type).toBe("Phone number");
    expect(match?.suggestion).toContain("phone number");
  });

  it("returns null for clean text", () => {
    expect(detectSensitiveData("let's grab coffee tomorrow at the cafe")).toBeNull();
  });

  it("returns null for empty, short, or missing input", () => {
    expect(detectSensitiveData("")).toBeNull();
    expect(detectSensitiveData("hi")).toBeNull();
    expect(detectSensitiveData(null)).toBeNull();
    expect(detectSensitiveData(undefined)).toBeNull();
  });
});
