package com.cipherchat.upload;

import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import com.cipherchat.shared.api.ApiException;
import com.cipherchat.shared.infra.RedisRateLimiter;
import com.cipherchat.shared.security.CurrentUser;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;

/**
 * Three upload paths, deliberately separate:
 * <ol>
 *   <li>{@code /} — plaintext room attachments; strict MIME allowlist.</li>
 *   <li>{@code /encrypted} — opaque E2EE blobs (client-encrypted, AES-GCM);
 *       only {@code application/octet-stream}, name never trusted.</li>
 *   <li>{@code /encrypted/presign} — same, but direct-to-bucket; 501 on the
 *       local driver so the client falls back to (2).</li>
 * </ol>
 */
@RestController
@RequestMapping("/api/v1/uploads")
@EnableConfigurationProperties(StorageProperties.class)
@Tag(name = "Uploads", description = "Attachments: plaintext (rooms) and encrypted blobs (DMs)")
public class UploadController {

    private static final Logger log = LoggerFactory.getLogger(UploadController.class);
    private static final Set<String> ALLOWED_MIME = Set.of(
            "image/jpeg", "image/png", "image/gif", "image/webp",
            "audio/webm", "audio/ogg", "audio/mpeg", "audio/wav",
            "application/pdf", "text/plain", "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    private static final long ENCRYPTED_SLACK = 64 * 1024;   // GCM tag + padding
    private static final int UPLOADS_PER_MINUTE = 30;

    public record UploadResponse(String url, String fileName, String mimeType, long fileSize) {
    }

    public record EncryptedResponse(String url, long fileSize) {
    }

    public record PresignRequest(Long size) {
    }

    public record PresignResponse(String uploadUrl, Map<String, String> headers, String url, long expiresSeconds) {
    }

    private final FileStorage storage;
    private final StorageProperties props;
    private final RedisRateLimiter rateLimiter;

    public UploadController(FileStorage storage, StorageProperties props, RedisRateLimiter rateLimiter) {
        this.storage = storage;
        this.props = props;
        this.rateLimiter = rateLimiter;
    }

    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    @Operation(summary = "Upload a room attachment (images, audio, pdf, docs; 10 MB)")
    public UploadResponse upload(@RequestPart("file") MultipartFile file) {
        UUID userId = throttle();
        String mime = file.getContentType() == null ? "" : file.getContentType().split(";")[0].trim().toLowerCase();
        if (!ALLOWED_MIME.contains(mime)) throw new ApiException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type", "File type not allowed.");
        if (file.getSize() > props.maxFileBytes()) throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "file_too_large", "File exceeds 10 MB.");
        FileStorage.Stored stored = storage.put(safeName(file.getOriginalFilename()), mime, bytes(file));
        log.info("File uploaded key={} driver={} userId={} bytes={}", stored.key(), storage.driver(), userId, stored.fileSize());
        return new UploadResponse(stored.url(), stored.fileName(), stored.mimeType(), stored.fileSize());
    }

    @PostMapping(value = "/encrypted", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    @Operation(summary = "Upload an opaque client-encrypted blob (DM attachments)")
    public EncryptedResponse uploadEncrypted(@RequestPart("file") MultipartFile file) {
        UUID userId = throttle();
        String mime = file.getContentType() == null ? "" : file.getContentType().split(";")[0].trim().toLowerCase();
        if (!MediaType.APPLICATION_OCTET_STREAM_VALUE.equals(mime)) {
            throw new ApiException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type", "Encrypted uploads must be application/octet-stream.");
        }
        if (file.getSize() > props.maxFileBytes() + ENCRYPTED_SLACK) throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "file_too_large", "Blob exceeds the cap.");
        FileStorage.Stored stored = storage.put("encrypted.bin", MediaType.APPLICATION_OCTET_STREAM_VALUE, bytes(file));
        log.info("Encrypted blob uploaded key={} driver={} userId={} bytes={}", stored.key(), storage.driver(), userId, stored.fileSize());
        return new EncryptedResponse(stored.url(), stored.fileSize());
    }

    @PostMapping("/encrypted/presign")
    @Operation(summary = "Presigned direct-to-bucket PUT for an encrypted blob (object storage only)")
    public PresignResponse presign(@RequestBody PresignRequest body) {
        UUID userId = throttle();
        long size = body == null || body.size() == null ? -1 : body.size();
        if (size <= 0 || size > props.maxFileBytes() + ENCRYPTED_SLACK) {
            throw ApiException.badRequest("invalid_size", "size must be a positive integer within the upload cap.");
        }
        FileStorage.Presigned p = storage.presignPut(MediaType.APPLICATION_OCTET_STREAM_VALUE, size, props.s3().presignTtl())
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_IMPLEMENTED, "presign_unsupported", "Direct uploads need object storage (STORAGE_DRIVER=s3)."));
        log.info("Encrypted blob presigned key={} userId={} bytes={}", p.key(), userId, size);
        return new PresignResponse(p.uploadUrl(), p.headers(), p.url(), p.expiresSeconds());
    }

    private UUID throttle() {
        UUID userId = CurrentUser.id();
        if (!rateLimiter.tryAcquire("rl:upload:" + userId, UPLOADS_PER_MINUTE, UPLOADS_PER_MINUTE / 60.0)) {
            throw ApiException.tooManyRequests("Too many uploads — try again in a minute.");
        }
        return userId;
    }

    private static byte[] bytes(MultipartFile file) {
        try {
            return file.getBytes();
        } catch (IOException e) {
            throw ApiException.badRequest("upload_failed", "Could not read the uploaded file.");
        }
    }

    private static String safeName(String original) {
        if (original == null || original.isBlank()) return "file";
        String base = original.replace('\\', '/');
        base = base.substring(base.lastIndexOf('/') + 1);
        return base.length() > 120 ? base.substring(base.length() - 120) : base;
    }
}
