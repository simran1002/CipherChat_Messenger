import { describe, expect, it } from "vitest";
import { formatDateDivider, getInitials, stringToColor } from "./helpers";

describe("stringToColor", () => {
  it("is deterministic for the same input", () => {
    expect(stringToColor("alice")).toBe(stringToColor("alice"));
  });

  it("returns the fallback for empty input", () => {
    expect(stringToColor("")).toBe("#6366f1");
    expect(stringToColor(null)).toBe("#6366f1");
  });

  it("returns a hex color", () => {
    expect(stringToColor("bob")).toMatch(/^#[0-9A-F]{6}$/);
  });
});

describe("getInitials", () => {
  it("uses first and last name", () => {
    expect(getInitials("Ada Lovelace")).toBe("AL");
  });

  it("uses a single letter for single names", () => {
    expect(getInitials("Plato")).toBe("P");
  });

  it("falls back to U", () => {
    expect(getInitials("")).toBe("U");
    expect(getInitials(undefined)).toBe("U");
  });
});

describe("formatDateDivider", () => {
  it("labels today", () => {
    expect(formatDateDivider(new Date())).toBe("Today");
  });

  it("labels yesterday", () => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    expect(formatDateDivider(y)).toBe("Yesterday");
  });

  it("returns empty string for missing input", () => {
    expect(formatDateDivider(null)).toBe("");
  });
});
