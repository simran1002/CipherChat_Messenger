package com.cipherchat.upload;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class LocalFileStorageTest {

    @Test
    void keyExtensionComesFromTheValidatedContentType_neverTheClientFilename(@TempDir Path dir) throws Exception {
        var props = new StorageProperties("local", 10, new StorageProperties.Local(dir.toString(), "http://h/"), null);
        var storage = new LocalFileStorage(props);

        // A client naming its file ".html" while the (already allow-list-checked) content type is
        // image/png must still be stored — and therefore served — as a .png, never a .html: the on-disk
        // extension governs what the servlet container serves it back as, independent of any header the
        // upload arrived with.
        var stored = storage.put("totally-a-photo.html", "image/png", "not really html".getBytes());

        assertThat(stored.key()).endsWith(".png");
        assertThat(stored.fileName()).isEqualTo("totally-a-photo.html");   // kept only as display metadata
    }

    @Test
    void unrecognisedContentTypeFallsBackToBin(@TempDir Path dir) throws Exception {
        var props = new StorageProperties("local", 10, new StorageProperties.Local(dir.toString(), "http://h/"), null);
        var storage = new LocalFileStorage(props);

        var stored = storage.put("encrypted.bin", "application/octet-stream", "opaque".getBytes());

        assertThat(stored.key()).endsWith(".bin");
    }

    @Test
    void storesUnderARandomKeyInsideTheDir_neverTheClientName(@TempDir Path dir) throws Exception {
        var props = new StorageProperties("local", 10, new StorageProperties.Local(dir.toString(), "http://h/"), null);
        var storage = new LocalFileStorage(props);

        var stored = storage.put("../../etc/passwd.txt", "text/plain", "hello".getBytes());

        assertThat(stored.key()).matches("[0-9a-f-]{36}\\.txt");
        assertThat(stored.url()).isEqualTo("http://h/uploads/" + stored.key());
        assertThat(stored.fileName()).isEqualTo("../../etc/passwd.txt");     // metadata only
        assertThat(Files.readString(dir.resolve(stored.key()))).isEqualTo("hello");
        try (var listing = Files.list(dir)) {
            assertThat(listing).hasSize(1);
        }
    }
}
