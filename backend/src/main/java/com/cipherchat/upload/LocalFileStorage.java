package com.cipherchat.upload;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Disk driver for dev and single-node deployments. Keys are random UUIDs +
 * a sanitised extension — the client-supplied name is returned as metadata
 * but never used as a path, so traversal is impossible by construction.
 * Files are served by Spring's resource handler at {@code /uploads/**}.
 */
@Component
@ConditionalOnProperty(name = "cipherchat.storage.driver", havingValue = "local", matchIfMissing = true)
class LocalFileStorage implements FileStorage {

    private static final Logger log = LoggerFactory.getLogger(LocalFileStorage.class);

    private final Path dir;
    private final String publicBaseUrl;

    LocalFileStorage(StorageProperties props) {
        this.dir = Path.of(props.local().dir()).toAbsolutePath().normalize();
        this.publicBaseUrl = props.local().publicBaseUrl().replaceAll("/+$", "");
        try {
            Files.createDirectories(dir);
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot create upload dir " + dir, e);
        }
        log.info("Local file storage at {}", dir);
    }

    @Override
    public String driver() {
        return "local";
    }

    @Override
    public Stored put(String fileName, String contentType, byte[] bytes) {
        String key = UUID.randomUUID() + extensionOf(fileName);
        Path target = dir.resolve(key).normalize();
        if (!target.startsWith(dir)) throw new IllegalArgumentException("Bad key");   // belt and braces
        try {
            Files.write(target, bytes);
        } catch (IOException e) {
            throw new UncheckedIOException("Write failed for " + key, e);
        }
        return new Stored(key, publicBaseUrl + "/uploads/" + key, fileName, contentType, bytes.length);
    }

    /** Only a short [a-z0-9] extension survives; anything else (e.g. ".php.jpg" games) is dropped. */
    static String extensionOf(String fileName) {
        if (fileName == null) return "";
        int dot = fileName.lastIndexOf('.');
        if (dot < 0 || dot == fileName.length() - 1) return "";
        String ext = fileName.substring(dot + 1).toLowerCase();
        return ext.matches("[a-z0-9]{1,5}") ? "." + ext : "";
    }

    @Configuration
    @ConditionalOnProperty(name = "cipherchat.storage.driver", havingValue = "local", matchIfMissing = true)
    static class ServeUploads implements WebMvcConfigurer {
        private final StorageProperties props;

        ServeUploads(StorageProperties props) {
            this.props = props;
        }

        @Override
        public void addResourceHandlers(ResourceHandlerRegistry registry) {
            String location = Path.of(props.local().dir()).toAbsolutePath().normalize().toUri().toString();
            registry.addResourceHandler("/uploads/**").addResourceLocations(location).setCachePeriod(86_400);
        }
    }
}
