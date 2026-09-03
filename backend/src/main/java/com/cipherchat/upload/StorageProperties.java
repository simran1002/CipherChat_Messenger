package com.cipherchat.upload;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("cipherchat.storage")
public record StorageProperties(String driver, long maxFileBytes, Local local, S3 s3) {

    public record Local(String dir, String publicBaseUrl) {
    }

    public record S3(String bucket, String region, String endpoint, String publicBaseUrl, Duration presignTtl) {
    }
}
