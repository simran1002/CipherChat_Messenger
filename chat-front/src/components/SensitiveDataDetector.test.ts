import { describe, expect, it } from "vitest";
import { detectSensitiveData } from "./SensitiveDataDetector";

describe("detectSensitiveData", () => {
  it("detects a 16-digit credit card number", () => {
    const match = detectSensitiveData("my card is 4111 1111 1111 1111 ok");
    expect(match).not.toBeNull();
    expect(match?.type).toBe("Credit card number");
    expect(match?.suggestion).toContain("credit card");
  });

  it("detects a 6-digit OTP", () => {
    // Note: the OTP pattern requires the digits to appear BEFORE the keyword.
    const match = detectSensitiveData("123456 is your OTP, do not share it");
    expect(match).not.toBeNull();
    expect(match?.type).toBe("OTP / Verification code");
    expect(match?.suggestion).toContain("OTP");
  });

  it("detects a password disclosure", () => {
    const match = detectSensitiveData("password: hunter2");
    expect(match).not.toBeNull();
    expect(match?.type).toBe("Password");
    expect(match?.suggestion).toContain("password manager");
  });

  it("detects an sk- style API key with a key prefix", () => {
    const match = detectSensitiveData("api_key=sk-abc123def456ghi789jkl");
    expect(match).not.toBeNull();
    expect(match?.type).toBe("API key");
    expect(match?.suggestion).toContain("revoke");
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
