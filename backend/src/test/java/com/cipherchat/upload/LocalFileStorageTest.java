package com.cipherchat.upload;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class LocalFileStorageTest {

    @Test
    void extensionIsSanitised() {
        assertThat(LocalFileStorage.extensionOf("photo.JPG")).isEqualTo(".jpg");
        assertThat(LocalFileStorage.extensionOf("archive.tar.gz")).isEqualTo(".gz");
        assertThat(LocalFileStorage.extensionOf("noext")).isEmpty();
        assertThat(LocalFileStorage.extensionOf("trailingdot.")).isEmpty();
        assertThat(LocalFileStorage.extensionOf("evil.php%00.jpg")).isEqualTo(".jpg");
        assertThat(LocalFileStorage.extensionOf("x.toolongext")).isEmpty();
        assertThat(LocalFileStorage.extensionOf("x.a/b")).isEmpty();
        assertThat(LocalFileStorage.extensionOf(null)).isEmpty();
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
