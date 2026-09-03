package com.cipherchat.keys;

import static org.assertj.core.api.Assertions.assertThat;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Arrays;

import org.junit.jupiter.api.Test;

/** The key directory's only cryptographic duty: raw-key Ed25519 verification via the JDK, no third-party crypto. */
class Ed25519VerifyTest {

    private static byte[] rawPublic(KeyPair kp) {
        byte[] spki = kp.getPublic().getEncoded();          // X.509 SubjectPublicKeyInfo, 44 bytes
        return Arrays.copyOfRange(spki, spki.length - 32, spki.length);
    }

    @Test
    void verifiesAGenuineSignatureOverThePrekey() throws Exception {
        KeyPair identity = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        byte[] prekey = new byte[32];
        Arrays.fill(prekey, (byte) 7);

        Signature s = Signature.getInstance("Ed25519");
        s.initSign(identity.getPrivate());
        s.update(prekey);
        byte[] sig = s.sign();

        assertThat(sig).hasSize(64);
        assertThat(KeysController.verifyEd25519(rawPublic(identity), prekey, sig)).isTrue();
    }

    @Test
    void rejectsTamperedPrekey_wrongKey_andGarbage() throws Exception {
        KeyPair identity = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        KeyPair other = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        byte[] prekey = new byte[32];
        Signature s = Signature.getInstance("Ed25519");
        s.initSign(identity.getPrivate());
        s.update(prekey);
        byte[] sig = s.sign();

        byte[] tampered = prekey.clone();
        tampered[0] ^= 1;
        assertThat(KeysController.verifyEd25519(rawPublic(identity), tampered, sig)).isFalse();
        assertThat(KeysController.verifyEd25519(rawPublic(other), prekey, sig)).isFalse();
        assertThat(KeysController.verifyEd25519(new byte[32], prekey, sig)).isFalse();
        assertThat(KeysController.verifyEd25519(rawPublic(identity), prekey, new byte[64])).isFalse();
        assertThat(KeysController.verifyEd25519(new byte[5], prekey, sig)).isFalse();   // malformed key → false, not throw
    }
}
