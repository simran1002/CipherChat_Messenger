package com.cipherchat.upload;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class MimeExtensionsTest {

    @Test
    void mapsEveryAllowedUploadTypeToItsExtension() {
        assertThat(MimeExtensions.forContentType("image/jpeg")).isEqualTo("jpg");
        assertThat(MimeExtensions.forContentType("image/png")).isEqualTo("png");
        assertThat(MimeExtensions.forContentType("image/gif")).isEqualTo("gif");
        assertThat(MimeExtensions.forContentType("image/webp")).isEqualTo("webp");
        assertThat(MimeExtensions.forContentType("audio/webm")).isEqualTo("webm");
        assertThat(MimeExtensions.forContentType("audio/ogg")).isEqualTo("ogg");
        assertThat(MimeExtensions.forContentType("audio/mpeg")).isEqualTo("mp3");
        assertThat(MimeExtensions.forContentType("audio/wav")).isEqualTo("wav");
        assertThat(MimeExtensions.forContentType("application/pdf")).isEqualTo("pdf");
        assertThat(MimeExtensions.forContentType("text/plain")).isEqualTo("txt");
        assertThat(MimeExtensions.forContentType("application/msword")).isEqualTo("doc");
        assertThat(MimeExtensions.forContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
                .isEqualTo("docx");
    }

    @Test
    void unknownOrDangerousTypesFallBackToBin() {
        assertThat(MimeExtensions.forContentType("application/octet-stream")).isEqualTo("bin");
        assertThat(MimeExtensions.forContentType("text/html")).isEqualTo("bin");
        assertThat(MimeExtensions.forContentType("image/svg+xml")).isEqualTo("bin");
        assertThat(MimeExtensions.forContentType(null)).isEqualTo("bin");
    }
}
