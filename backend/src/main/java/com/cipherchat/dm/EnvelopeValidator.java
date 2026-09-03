package com.cipherchat.dm;

import java.util.Base64;
import java.util.Map;

import com.cipherchat.shared.api.ApiException;

/**
 * Structural validation of an E2EE envelope — the only thing the server can
 * check, and everything it should. Bounds every field so a hostile client
 * cannot use the opaque channel as unlimited storage or a parser attack.
 *
 * <pre>{ v:1, sessionId, ctr, ct, init?: { ephPub, ik, spkId } }</pre>
 *
 * MAX_CT_BYTES: the client pads plaintext to 256-byte buckets, so a 2000-char
 * message (the UI limit, ≤ 8 KB in UTF-8) seals to ≤ 8.3 KB — 16 KB leaves
 * headroom for the attachment descriptor variant without inviting abuse.
 */
final class EnvelopeValidator {

    private static final int MAX_CT_BYTES = 16 * 1024;
    private static final int KEY_BYTES = 32;

    private EnvelopeValidator() {
    }

    static void validate(Map<String, Object> e) {
        if (e == null) throw bad("Envelope is required.");
        if (!(e.get("v") instanceof Number v) || v.intValue() != 1) throw bad("Unsupported envelope version.");
        if (!(e.get("sessionId") instanceof String sid) || sid.isEmpty() || sid.length() > 64) throw bad("Malformed sessionId.");
        if (!(e.get("ctr") instanceof Number ctr) || ctr.longValue() < 0 || ctr.longValue() > 1_000_000_000L) throw bad("Malformed counter.");
        if (!(e.get("ct") instanceof String ct) || ct.isEmpty() || ct.length() > MAX_CT_BYTES * 4 / 3 + 4) throw bad("Ciphertext missing or too large.");
        if (decodedLength(ct) > MAX_CT_BYTES || decodedLength(ct) < 16) throw bad("Ciphertext size out of range.");

        Object init = e.get("init");
        if (init != null) {
            if (!(init instanceof Map<?, ?> m)) throw bad("Malformed init block.");
            if (!(m.get("ephPub") instanceof String eph) || decodedLength(eph) != KEY_BYTES) throw bad("Malformed ephemeral key.");
            if (!(m.get("ik") instanceof String ik) || decodedLength(ik) != KEY_BYTES) throw bad("Malformed identity key.");
            if (!(m.get("spkId") instanceof Number)) throw bad("Malformed prekey id.");
        }
        for (String k : e.keySet()) {
            if (!k.equals("v") && !k.equals("sessionId") && !k.equals("ctr") && !k.equals("ct") && !k.equals("init")) {
                throw bad("Unexpected envelope field: " + k);
            }
        }
    }

    static String sessionId(Map<String, Object> e) {
        return (String) e.get("sessionId");
    }

    static long counter(Map<String, Object> e) {
        return ((Number) e.get("ctr")).longValue();
    }

    private static int decodedLength(String b64) {
        try {
            return Base64.getDecoder().decode(b64).length;
        } catch (IllegalArgumentException ex) {
            throw bad("Invalid base64 in envelope.");
        }
    }

    private static ApiException bad(String message) {
        return ApiException.badRequest("invalid_message", message);
    }
}
