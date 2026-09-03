package com.cipherchat.auth;

import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.time.Instant;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * RFC 6238 TOTP (HMAC-SHA1, 30-second step, 6 digits) — the profile every
 * authenticator app implements. Implemented directly (~60 lines) rather than
 * pulling a library: the algorithm is small, fully specified, and a dependency
 * would be the only thing in this class worth auditing.
 */
final class Totp {

    private static final String ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    private static final SecureRandom RANDOM = new SecureRandom();
    static final int STEP_SECONDS = 30;
    static final int DIGITS = 6;

    private Totp() {
    }

    /** 160-bit secret, base32 — the format authenticator apps expect. */
    static String generateSecret() {
        byte[] bytes = new byte[20];
        RANDOM.nextBytes(bytes);
        return base32Encode(bytes);
    }

    static String otpauthUri(String issuer, String label, String secret) {
        String enc = URLEncoder.encode(issuer, StandardCharsets.UTF_8);
        String lbl = URLEncoder.encode(label, StandardCharsets.UTF_8);
        return "otpauth://totp/" + enc + ":" + lbl + "?secret=" + secret + "&issuer=" + enc
                + "&algorithm=SHA1&digits=" + DIGITS + "&period=" + STEP_SECONDS;
    }

    static String code(String secret, long timeStep) {
        try {
            Mac mac = Mac.getInstance("HmacSHA1");
            mac.init(new SecretKeySpec(base32Decode(secret), "HmacSHA1"));
            byte[] hash = mac.doFinal(ByteBuffer.allocate(8).putLong(timeStep).array());
            int offset = hash[hash.length - 1] & 0x0F;
            int binary = ((hash[offset] & 0x7F) << 24) | ((hash[offset + 1] & 0xFF) << 16)
                    | ((hash[offset + 2] & 0xFF) << 8) | (hash[offset + 3] & 0xFF);
            int otp = binary % 1_000_000;
            return String.format("%06d", otp);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA1 unavailable", e);
        }
    }

    /** Accepts the current step and one either side (±30s of authenticator clock skew). */
    static boolean verify(String secret, String code, Instant now) {
        if (code == null || !code.matches("\\d{6}")) return false;
        long step = now.getEpochSecond() / STEP_SECONDS;
        for (long s = step - 1; s <= step + 1; s++) {
            if (constantTimeEquals(code(secret, s), code)) return true;
        }
        return false;
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a.length() != b.length()) return false;
        int diff = 0;
        for (int i = 0; i < a.length(); i++) diff |= a.charAt(i) ^ b.charAt(i);
        return diff == 0;
    }

    static String base32Encode(byte[] data) {
        StringBuilder sb = new StringBuilder();
        int buffer = 0, bits = 0;
        for (byte b : data) {
            buffer = (buffer << 8) | (b & 0xFF);
            bits += 8;
            while (bits >= 5) {
                sb.append(ALPHABET.charAt((buffer >> (bits - 5)) & 31));
                bits -= 5;
            }
        }
        if (bits > 0) sb.append(ALPHABET.charAt((buffer << (5 - bits)) & 31));
        return sb.toString();
    }

    static byte[] base32Decode(String s) {
        String clean = s.toUpperCase().replace("=", "").replace(" ", "");
        ByteBuffer out = ByteBuffer.allocate(clean.length() * 5 / 8);
        int buffer = 0, bits = 0;
        for (char c : clean.toCharArray()) {
            int val = ALPHABET.indexOf(c);
            if (val < 0) throw new IllegalArgumentException("Invalid base32");
            buffer = (buffer << 5) | val;
            bits += 5;
            if (bits >= 8) {
                out.put((byte) ((buffer >> (bits - 8)) & 0xFF));
                bits -= 8;
            }
        }
        byte[] result = new byte[out.position()];
        out.flip();
        out.get(result);
        return result;
    }
}
