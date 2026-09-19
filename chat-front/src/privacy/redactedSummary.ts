import api from "../services/api";
import { PII_POLICY_VERSION, PiiRedactor, containsPii, rehydrate } from "./piiRedactor";

export interface TranscriptLine {
  who: string;
  text: string;
}

export interface RedactedSummary {
  summary: string;
  /** How many entities of each type were replaced before anything left the device. */
  entityCounts: Record<string, number>;
}

/**
 * Summarise a transcript without sending identifiable data to the server or the model:
 * redact locally → POST tokens only → rehydrate the answer locally. The token map lives in this
 * function's scope and is garbage once it returns.
 *
 * Refuses to send if the local self-check still finds PII after redaction — the server would
 * refuse too (422 pii_detected), but failing before the network call is the point.
 */
export async function summarizeRedacted(
  scope: "room" | "dm",
  scopeId: string,
  lines: TranscriptLine[],
  knownNames: string[]
): Promise<RedactedSummary> {
  const redactor = new PiiRedactor({ names: [...knownNames, ...lines.map((l) => l.who)] });
  const transcript = lines
    .filter((l) => l.text && l.text.trim().length > 0)
    .map((l) => ({ who: redactor.redact(l.who), text: redactor.redact(l.text) }));

  const leaked = containsPii(transcript.map((l) => `${l.who}: ${l.text}`).join("\n"));
  if (leaked.length > 0) {
    throw new Error(`Redaction self-check failed (${leaked.join(", ")}) — nothing was sent.`);
  }

  const entityCounts = redactor.entityCounts();
  const res = await api.post<{ summary: string }>("/api/v1/ai/summarize-redacted", {
    scope,
    scopeId,
    policyVersion: PII_POLICY_VERSION,
    transcript,
    entityCounts,
  });
  return { summary: rehydrate(res.data.summary, redactor.tokenMap()), entityCounts };
}
