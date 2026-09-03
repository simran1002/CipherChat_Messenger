package com.cipherchat.auth;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

import org.springframework.stereotype.Component;

/**
 * Reversible encryption for small server-side secrets that must be readable
 * again (TOTP seeds — unlike passwords they are compared by <em>recomputing</em>
 * codes). AES-256-GCM under a key derived from the seal secret, so a database
 * dump alone does not yield working authenticator seeds.
 *
 * <p>Deliberately NOT for user content — content encryption is the client's
 * job (E2EE). This only raises the bar from "read the users table" to "read
 * the users table AND the server's environment".
 */
@Component
public class SecretBox {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    private final SecretKeySpec key;

    public SecretBox(SecurityProperties props) {
        try {
            byte[] derived = MessageDigest.getInstance("SHA-256")
                    .digest((props.sealSecret() + ":2fa-secret-box:v1").getBytes(StandardCharsets.UTF_8));
            this.key = new SecretKeySpec(derived, "AES");
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("AES/SHA-256 unavailable", e);
        }
    }

    public String seal(String plaintext) {
        try {
            byte[] iv = new byte[IV_BYTES];
            RANDOM.nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            byte[] ct = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            return Base64.getEncoder().encodeToString(out);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("seal failed", e);
        }
    }

    public String open(String sealed) {
        try {
            byte[] raw = Base64.getDecoder().decode(sealed);
            byte[] iv = Arrays.copyOfRange(raw, 0, IV_BYTES);
            byte[] ct = Arrays.copyOfRange(raw, IV_BYTES, raw.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            return new String(cipher.doFinal(ct), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            throw new IllegalStateException("open failed (wrong seal secret or corrupt data)", e);
        }
    }
}
