package com.cipherchat.upload;

import java.util.Map;

/**
 * Maps a server-validated MIME type to the extension a file is stored under.
 *
 * <p>The on-disk (or bucket) extension used to come from the CLIENT-supplied filename
 * ({@code extensionOf(originalFilename)}), while the content type was checked separately against an
 * allow-list. That let a client declare {@code image/png} but name the file {@code x.html}: the bytes
 * were stored with a {@code .html} key, and the servlet container serves {@code /uploads/**} by the
 * key's extension — so a browser opening the link got {@code text/html}, not {@code image/png}, and any
 * script inside the "image" executed on the API origin.
 *
 * <p>The extension must instead be a function of the type that was actually validated, so what a browser
 * is served can never diverge from what the allow-list approved. The client's filename is kept only as
 * cosmetic metadata (a caption), never as a path or extension input.
 */
final class MimeExtensions {

    private static final Map<String, String> BY_MIME = Map.ofEntries(
            Map.entry("image/jpeg", "jpg"),
            Map.entry("image/png", "png"),
            Map.entry("image/gif", "gif"),
            Map.entry("image/webp", "webp"),
            Map.entry("audio/webm", "webm"),
            Map.entry("audio/ogg", "ogg"),
            Map.entry("audio/mpeg", "mp3"),
            Map.entry("audio/wav", "wav"),
            Map.entry("application/pdf", "pdf"),
            Map.entry("text/plain", "txt"),
            Map.entry("application/msword", "doc"),
            Map.entry("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"));

    private MimeExtensions() {
    }

    /** The extension for an allow-listed type; {@code "bin"} for anything else (opaque encrypted blobs). */
    static String forContentType(String mime) {
        return mime == null ? "bin" : BY_MIME.getOrDefault(mime, "bin");
    }
}
