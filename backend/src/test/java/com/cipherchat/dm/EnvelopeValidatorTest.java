package com.cipherchat.dm;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.cipherchat.shared.api.ApiException;

class EnvelopeValidatorTest {

    private static String b64(int len) {
        return Base64.getEncoder().encodeToString(new byte[len]);
    }

    private static Map<String, Object> valid() {
        Map<String, Object> e = new HashMap<>();
        e.put("v", 1);
        e.put("sessionId", "0f3c0a9e-3b1c-4d0e-9c0d-2f4b8a1e7c11");
        e.put("ctr", 42);
        e.put("ct", b64(256));
        return e;
    }

    @Test
    void acceptsMinimalAndInitialisingEnvelopes() {
        assertThatCode(() -> EnvelopeValidator.validate(valid())).doesNotThrowAnyException();

        Map<String, Object> withInit = valid();
        withInit.put("init", Map.of("ephPub", b64(32), "ik", b64(32), "spkId", 7));
        assertThatCode(() -> EnvelopeValidator.validate(withInit)).doesNotThrowAnyException();
    }

    @Test
    void rejectsWrongVersion() {
        Map<String, Object> e = valid();
        e.put("v", 2);
        assertThatThrownBy(() -> EnvelopeValidator.validate(e)).isInstanceOf(ApiException.class)
                .hasMessageContaining("version");
    }

    @Test
    void rejectsNegativeOrMissingCounter() {
        Map<String, Object> e = valid();
        e.put("ctr", -1);
        assertThatThrownBy(() -> EnvelopeValidator.validate(e)).isInstanceOf(ApiException.class);
        e.remove("ctr");
        assertThatThrownBy(() -> EnvelopeValidator.validate(e)).isInstanceOf(ApiException.class);
    }

    @Test
    void boundsCiphertextSize() {
        Map<String, Object> tiny = valid();
        tiny.put("ct", b64(8));                       // shorter than a GCM tag — cannot be real
        assertThatThrownBy(() -> EnvelopeValidator.validate(tiny)).isInstanceOf(ApiException.class);

        Map<String, Object> huge = valid();
        huge.put("ct", b64(16 * 1024 + 1));
        assertThatThrownBy(() -> EnvelopeValidator.validate(huge)).isInstanceOf(ApiException.class);
    }

    @Test
    void rejectsBadBase64AndBadInitKeys() {
        Map<String, Object> e = valid();
        e.put("ct", "not*base64!");
        assertThatThrownBy(() -> EnvelopeValidator.validate(e)).isInstanceOf(ApiException.class);

        Map<String, Object> shortKey = valid();
        shortKey.put("init", Map.of("ephPub", b64(31), "ik", b64(32), "spkId", 1));
        assertThatThrownBy(() -> EnvelopeValidator.validate(shortKey)).isInstanceOf(ApiException.class);
    }

    @Test
    void rejectsUnknownFields_noSmugglingThroughTheOpaqueChannel() {
        Map<String, Object> e = valid();
        e.put("extra", "x".repeat(10));
        assertThatThrownBy(() -> EnvelopeValidator.validate(e)).isInstanceOf(ApiException.class)
                .hasMessageContaining("Unexpected");
    }
}
