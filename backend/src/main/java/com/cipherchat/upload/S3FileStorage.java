package com.cipherchat.upload;

import java.net.URI;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3ClientBuilder;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.PutObjectPresignRequest;

/**
 * Object-storage driver (AWS S3, or MinIO/LocalStack via {@code endpoint}).
 * Credentials come from the default AWS chain (env, profile, IRSA/instance
 * role) — never from application config. The presigned PUT pins content
 * type AND length, so the upload cap is enforced bucket-side as well.
 */
@Component
@ConditionalOnProperty(name = "cipherchat.storage.driver", havingValue = "s3")
class S3FileStorage implements FileStorage {

    private static final Logger log = LoggerFactory.getLogger(S3FileStorage.class);

    private final S3Client s3;
    private final S3Presigner presigner;
    private final String bucket;
    private final String publicBaseUrl;

    S3FileStorage(StorageProperties props) {
        StorageProperties.S3 cfg = props.s3();
        if (cfg.bucket() == null || cfg.bucket().isBlank()) {
            throw new IllegalStateException("cipherchat.storage.s3.bucket is required when driver=s3");
        }
        Region region = Region.of(cfg.region());
        boolean custom = cfg.endpoint() != null && !cfg.endpoint().isBlank();
        S3ClientBuilder builder = S3Client.builder().region(region)
                .httpClientBuilder(UrlConnectionHttpClient.builder());
        S3Presigner.Builder presignBuilder = S3Presigner.builder().region(region);
        if (custom) {
            // MinIO/LocalStack: path-style addressing, explicit endpoint.
            builder.endpointOverride(URI.create(cfg.endpoint()))
                    .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build());
            presignBuilder.endpointOverride(URI.create(cfg.endpoint()))
                    .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build());
        }
        this.s3 = builder.build();
        this.presigner = presignBuilder.build();
        this.bucket = cfg.bucket();
        this.publicBaseUrl = cfg.publicBaseUrl() != null && !cfg.publicBaseUrl().isBlank()
                ? cfg.publicBaseUrl().replaceAll("/+$", "")
                : custom ? cfg.endpoint().replaceAll("/+$", "") + "/" + bucket
                : "https://" + bucket + ".s3." + cfg.region() + ".amazonaws.com";
        log.info("S3 file storage bucket={} region={} endpoint={}", bucket, cfg.region(), custom ? cfg.endpoint() : "aws");
    }

    @Override
    public String driver() {
        return "s3";
    }

    @Override
    public Stored put(String fileName, String contentType, byte[] bytes) {
        String key = "uploads/" + UUID.randomUUID() + LocalFileStorage.extensionOf(fileName);
        s3.putObject(PutObjectRequest.builder().bucket(bucket).key(key).contentType(contentType)
                .contentLength((long) bytes.length).build(), RequestBody.fromBytes(bytes));
        return new Stored(key, publicBaseUrl + "/" + key, fileName, contentType, bytes.length);
    }

    @Override
    public Optional<Presigned> presignPut(String contentType, long contentLength, Duration ttl) {
        String key = "uploads/" + UUID.randomUUID() + ".bin";
        var request = PutObjectRequest.builder().bucket(bucket).key(key)
                .contentType(contentType).contentLength(contentLength).build();
        var presigned = presigner.presignPutObject(PutObjectPresignRequest.builder()
                .signatureDuration(ttl).putObjectRequest(request).build());
        return Optional.of(new Presigned(key, presigned.url().toString(),
                Map.of("Content-Type", contentType, "Content-Length", String.valueOf(contentLength)),
                publicBaseUrl + "/" + key, ttl.toSeconds()));
    }
}
