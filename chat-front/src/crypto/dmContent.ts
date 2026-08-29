/**
 * What actually travels inside a DM envelope's plaintext.
 *
 * Backward compatible by construction: a plain text message is sealed as the
 * raw string, exactly as before (old clients and existing history keep
 * working, previews stay readable). Structured content (attachments) is a
 * JSON object carrying the sentinel `__dmc: 1`; parse() falls back to
 * treating anything else as text.
 */
import type { DmFileDescriptor } from "./fileCrypto";

export type DmContent =
  | { t: "text"; text: string }
  | { t: "file"; file: DmFileDescriptor & { url: string } };

interface WireShape {
  __dmc: 1;
  t: "file";
  file: DmFileDescriptor & { url: string };
}

export function serializeDmContent(content: DmContent): string {
  if (content.t === "text") return content.text; // raw string — envelope compat
  const wire: WireShape = { __dmc: 1, t: "file", file: content.file };
  return JSON.stringify(wire);
}

export function parseDmContent(plaintext: string): DmContent {
  if (plaintext.startsWith('{"__dmc"')) {
    try {
      const parsed = JSON.parse(plaintext) as Partial<WireShape>;
      if (
        parsed.__dmc === 1 &&
        parsed.t === "file" &&
        parsed.file &&
        typeof parsed.file.url === "string" &&
        typeof parsed.file.k === "string" &&
        typeof parsed.file.iv === "string"
      ) {
        return { t: "file", file: parsed.file as WireShape["file"] };
      }
    } catch {
      /* fall through to text */
    }
  }
  return { t: "text", text: plaintext };
}

/** Sidebar/notification preview line for a piece of content. */
export function previewDmContent(content: DmContent): string {
  return content.t === "file" ? `📎 ${content.file.name}` : content.text;
}
