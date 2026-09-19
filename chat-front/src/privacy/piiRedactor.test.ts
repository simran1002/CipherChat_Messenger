import { describe, expect, it } from "vitest";
import { PiiRedactor, containsPii, luhnValid, redact, rehydrate } from "./piiRedactor";

describe("piiRedactor", () => {
  it("redacts structured identifiers and reports counts", () => {
    const r = redact("Mail anika.rao@clinic.org or call +91 98765 43210. Card 4111 1111 1111 1111, SSN 123-45-6789.");
    expect(r.text).toBe("Mail [EMAIL_1] or call [PHONE_1]. Card [CARD_1], SSN [GOV_ID_1].");
    expect(r.counts).toMatchObject({ EMAIL: 1, PHONE: 1, CARD: 1, GOV_ID: 1 });
    expect(containsPii(r.text)).toEqual([]);
  });

  it("only treats Luhn-valid digit runs as cards", () => {
    expect(luhnValid("4111 1111 1111 1111")).toBe(true);
    expect(luhnValid("4111 1111 1111 1112")).toBe(false);
    expect(redact("order 1234 5678 9012 3456 shipped").counts.CARD).toBe(0);
  });

  it("redacts roster names, full name before parts, case-insensitively", () => {
    const r = redact("Anika Rao said anika will ask RAO's team. Banika is unrelated.", { names: ["Anika Rao"] });
    expect(r.text).toBe("[PERSON_1] said [PERSON_2] will ask [PERSON_3]'s team. Banika is unrelated.");
    expect(r.map.get("[PERSON_1]")).toBe("Anika Rao");
  });

  it("maps the same value to the same token across lines in one session", () => {
    const session = new PiiRedactor({ names: ["Marcus Webb"] });
    const a = session.redact("Marcus Webb: ping me at m.webb@news.example");
    const b = session.redact("Elena: I mailed M.Webb@news.example already, Marcus Webb.");
    expect(a).toBe("[PERSON_1]: ping me at [EMAIL_1]");
    expect(b).toBe("Elena: I mailed [EMAIL_1] already, [PERSON_1].");
    expect(session.entityCounts()).toMatchObject({ PERSON: 1, EMAIL: 1 });
  });

  it("redacts medical record numbers, IPs and URLs", () => {
    const r = redact("MRN: AB-99812 seen from 10.20.30.40, chart at https://ehr.example/p/991?x=1");
    expect(r.text).toBe("[MRN_1] seen from [IP_1], chart at [URL_1]");
  });

  it("rehydrates model output and leaves unknown tokens alone", () => {
    const r = redact("Priya (priya@firm.in) will file by Friday.", { names: ["Priya"] });
    const summary = "- [PERSON_1] files by Friday\n- contact: [EMAIL_1]\n- unknown: [PERSON_9]";
    expect(rehydrate(summary, r.map)).toBe("- Priya files by Friday\n- contact: priya@firm.in\n- unknown: [PERSON_9]");
  });

  it("is idempotent on already-redacted text", () => {
    const once = redact("call 9876543210", {});
    expect(redact(once.text).text).toBe(once.text);
  });

  it("does not flag ordinary numbers, times or versions", () => {
    const text = "Build 4.1.1 passed 153 tests at 10:45 on 2026-09-19; p95 was 64 ms.";
    expect(redact(text).text).toBe(text);
  });
});
