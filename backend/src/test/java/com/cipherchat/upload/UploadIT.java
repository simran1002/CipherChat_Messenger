package com.cipherchat.upload;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;

import com.cipherchat.AbstractIntegrationTest;

/**
 * Uploads over the real stack. The stored key's extension used to come from the CLIENT's filename while the
 * content type was validated separately, and {@code /uploads/**} is served by extension — so a file named
 * {@code x.html} declared as {@code image/png} was accepted and then served back as {@code text/html} from the
 * API origin (stored XSS, with the refresh cookie a same-origin script away).
 */
class UploadIT extends AbstractIntegrationTest {

    private ResponseEntity<Map> upload(Session who, String path, String filename, String contentType, byte[] bytes) {
        MultiValueMap<String, Object> form = new LinkedMultiValueMap<>();
        form.add("file", new HttpEntityFile(filename, contentType, bytes).asPart());
        return http().post().uri("/api/v1/uploads" + path)
                .header(HttpHeaders.AUTHORIZATION, who.bearer())
                .contentType(MediaType.MULTIPART_FORM_DATA)
                .body(form).retrieve().toEntity(Map.class);
    }

    /** A multipart part with an explicit filename and content type. */
    private record HttpEntityFile(String filename, String contentType, byte[] bytes) {
        org.springframework.http.HttpEntity<ByteArrayResource> asPart() {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.parseMediaType(contentType));
            headers.setContentDispositionFormData("file", filename);
            return new org.springframework.http.HttpEntity<>(new ByteArrayResource(bytes) {
                @Override
                public String getFilename() {
                    return filename;
                }
            }, headers);
        }
    }

    @Test
    void aFileNamedHtmlButDeclaredAsAPng_isStoredAndServedAsAPng() {
        Session s = register("Uploader");
        byte[] payload = "<html><script>fetch('/api/v1/auth/refresh',{method:'POST'})</script></html>".getBytes();

        ResponseEntity<Map> res = upload(s, "", "innocent.html", "image/png", payload);

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        String url = (String) res.getBody().get("url");
        assertThat(url).endsWith(".png").doesNotContain(".html");
        // The display name survives as metadata; it just never decides how the bytes are served.
        assertThat(res.getBody()).containsEntry("fileName", "innocent.html");

        ResponseEntity<byte[]> served = http().get().uri(URI.create("http://localhost:" + port + URI.create(url).getPath()))
                .retrieve().toEntity(byte[].class);
        assertThat(served.getStatusCode().value()).isEqualTo(200);
        assertThat(served.getHeaders().getContentType()).isEqualTo(MediaType.IMAGE_PNG);
        assertThat(served.getHeaders().getFirst("X-Content-Type-Options")).isEqualToIgnoringCase("nosniff");
    }

    @Test
    void htmlAndSvgAreNotOnTheAllowList() {
        Session s = register("Uploader Two");
        assertThat(upload(s, "", "page.html", "text/html", "<b>hi</b>".getBytes()).getStatusCode().value()).isEqualTo(415);
        assertThat(upload(s, "", "vector.svg", "image/svg+xml", "<svg/>".getBytes()).getStatusCode().value()).isEqualTo(415);
    }

    @Test
    void anUnauthenticatedUploadIsRejected() {
        MultiValueMap<String, Object> form = new LinkedMultiValueMap<>();
        form.add("file", new HttpEntityFile("a.png", "image/png", new byte[] {1}).asPart());
        ResponseEntity<Map> res = http().post().uri("/api/v1/uploads").contentType(MediaType.MULTIPART_FORM_DATA)
                .body(form).retrieve().toEntity(Map.class);
        assertThat(res.getStatusCode().value()).isIn(401, 403);
    }
}
