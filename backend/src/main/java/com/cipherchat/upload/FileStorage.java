package com.cipherchat.upload;

import java.time.Duration;
import java.util.Map;
import java.util.Optional;

/** Where attachment bytes live. Implementations are selected by {@code cipherchat.storage.driver}. */
public interface FileStorage {

    record Stored(String key, String url, String fileName, String mimeType, long fileSize) {
    }

    record Presigned(String key, String uploadUrl, Map<String, String> headers, String url, long expiresSeconds) {
    }

    String driver();

    Stored put(String fileName, String contentType, byte[] bytes);

    /** Direct-to-bucket upload; empty when the driver cannot presign (local disk). */
    default Optional<Presigned> presignPut(String contentType, long contentLength, Duration ttl) {
        return Optional.empty();
    }
}
