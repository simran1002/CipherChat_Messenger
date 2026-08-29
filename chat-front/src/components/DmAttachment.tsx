/**
 * Encrypted DM attachment bubble body.
 *
 * Renders the metadata (name/size) that traveled inside the E2EE envelope.
 * The ciphertext blob is only fetched when the user clicks "Decrypt"; it is
 * decrypted locally (AES-GCM authenticates it, so a tampered blob fails
 * loudly) and exposed via a short-lived object URL that is revoked on
 * unmount. Images preview inline; every other type becomes a "Save" link.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowDownTrayIcon, PaperClipIcon } from "@heroicons/react/24/outline";
import { getApiUrl } from "../services/api";
import { decryptDmFile, type DmFileDescriptor } from "../crypto/fileCrypto";

interface DmAttachmentProps {
  file: DmFileDescriptor & { url: string };
  /** Sent by the current user — bubble chrome is the primary gradient. */
  isMine: boolean;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type DecryptStatus = "idle" | "decrypting" | "ready" | "error";

const DmAttachment = ({ file, isMine }: DmAttachmentProps) => {
  const [status, setStatus] = useState<DecryptStatus>("idle");
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  // Revoke the object URL when the bubble unmounts (conversation switch, etc.)
  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    },
    []
  );

  const handleDecrypt = async () => {
    if (status === "decrypting" || status === "ready") return;
    setStatus("decrypting");
    try {
      const href = file.url.startsWith("http") ? file.url : `${getApiUrl()}${file.url}`;
      const res = await fetch(href);
      if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
      const ciphertext = await res.arrayBuffer();
      const blob = await decryptDmFile(file, ciphertext); // throws on tamper
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      setObjectUrl(url);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  };

  const isImage = file.mime.startsWith("image/");
  const metaClass = isMine ? "text-primary-200" : "text-gray-400";
  const actionClass = isMine
    ? "text-white border-white/40 hover:bg-white/10"
    : "text-primary-400 border-primary-500/40 hover:bg-primary-500/10";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 min-w-0">
        <PaperClipIcon className="w-4 h-4 shrink-0" />
        <span className="font-medium truncate" title={file.name}>
          {file.name}
        </span>
        <span className={`text-[11px] shrink-0 ${metaClass}`}>{formatFileSize(file.size)}</span>
      </div>

      {status === "error" ? (
        <p className="text-xs text-red-400">Couldn't decrypt attachment</p>
      ) : status === "ready" && objectUrl ? (
        isImage ? (
          <a href={objectUrl} target="_blank" rel="noreferrer" aria-label={`Open ${file.name}`}>
            <img
              src={objectUrl}
              alt={file.name}
              className="max-h-64 max-w-full rounded-lg object-contain"
            />
          </a>
        ) : (
          <a
            href={objectUrl}
            download={file.name}
            className={`inline-flex items-center gap-1.5 text-xs font-medium border rounded-lg px-3 py-1.5 transition-colors ${actionClass}`}
          >
            <ArrowDownTrayIcon className="w-3.5 h-3.5" /> Save
          </a>
        )
      ) : (
        <button
          type="button"
          onClick={handleDecrypt}
          disabled={status === "decrypting"}
          className={`inline-flex items-center gap-1.5 text-xs font-medium border rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 ${actionClass}`}
        >
          {status === "decrypting" ? "Decrypting…" : "Decrypt"}
        </button>
      )}
    </div>
  );
};

export default DmAttachment;
