package com.cipherchat.keys;

import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.cipherchat.keys.KeysEntities.KeyBackup;
import com.cipherchat.keys.KeysEntities.UserKeys;
import com.cipherchat.shared.api.ApiException;
import com.cipherchat.shared.security.CurrentUser;
import com.cipherchat.user.UserService;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;

/**
 * E2EE key directory. The server verifies that the signed prekey really is
 * signed by the identity key (so the directory can't serve a mix-and-match
 * bundle) using the JDK's built-in Ed25519 — no crypto dependency. It never
 * sees a private key; the backup blob is opaque.
 */
@RestController
@RequestMapping("/api/v1/keys")
@Tag(name = "E2EE keys", description = "Public key directory + encrypted recovery backup")
@Transactional
public class KeysController {

    private static final Logger log = LoggerFactory.getLogger(KeysController.class);
    /** DER prefix that turns a raw 32-byte Ed25519 public key into SubjectPublicKeyInfo. */
    private static final byte[] ED25519_SPKI_PREFIX = hex("302a300506032b6570032100");
    private static final int MAX_BACKUP_BYTES = 128 * 1024;

    interface UserKeysRepo extends JpaRepository<UserKeys, UUID> {
    }

    interface KeyBackupRepo extends JpaRepository<KeyBackup, UUID> {
    }

    public record SignedPreKey(@NotNull Integer keyId, @NotBlank String pubX25519, @NotBlank String sig) {
    }

    public record PublishRequest(@NotBlank @Size(max = 128) String identityEd25519,
                                 @NotBlank @Size(max = 128) String identityX25519,
                                 @NotNull SignedPreKey signedPreKey) {
    }

    public record BundleView(String identityEd25519, String identityX25519, SignedPreKey signedPreKey, int keyVersion, Instant publishedAt) {
        static BundleView of(UserKeys k) {
            return new BundleView(k.identityEd25519, k.identityX25519,
                    new SignedPreKey(k.spkKeyId, k.spkPubX25519, k.spkSig), k.keyVersion, k.publishedAt);
        }
    }

    public record BackupRequest(@NotBlank String blob) {
    }

    private final UserKeysRepo keys;
    private final KeyBackupRepo backups;
    private final UserService users;

    public KeysController(UserKeysRepo keys, KeyBackupRepo backups, UserService users) {
        this.keys = keys;
        this.backups = backups;
        this.users = users;
    }

    @PutMapping
    @Operation(summary = "Publish (or replace) the caller's public key bundle; prekey signature is verified")
    public Map<String, Integer> publish(@jakarta.validation.Valid @RequestBody PublishRequest body) {
        byte[] edPub = b64(body.identityEd25519(), 32, "identity key");
        b64(body.identityX25519(), 32, "identity key");
        byte[] spkPub = b64(body.signedPreKey().pubX25519(), 32, "prekey");
        byte[] sig = b64(body.signedPreKey().sig(), 64, "prekey signature");
        if (!verifyEd25519(edPub, spkPub, sig)) {
            throw ApiException.badRequest("bad_prekey_signature", "Prekey signature invalid.");
        }

        UUID userId = CurrentUser.id();
        UserKeys row = keys.findById(userId).orElseGet(() -> {
            UserKeys k = new UserKeys();
            k.userId = userId;
            return k;
        });
        boolean identityChanged = row.identityEd25519 != null && !row.identityEd25519.equals(body.identityEd25519());
        if (identityChanged) row.keyVersion += 1;         // peers detect the reset → safety-number banner
        row.identityEd25519 = body.identityEd25519();
        row.identityX25519 = body.identityX25519();
        row.spkKeyId = body.signedPreKey().keyId();
        row.spkPubX25519 = body.signedPreKey().pubX25519();
        row.spkSig = body.signedPreKey().sig();
        row.publishedAt = Instant.now();
        keys.save(row);
        log.info("Key bundle published userId={} keyVersion={} identityChanged={}", userId, row.keyVersion, identityChanged);
        return Map.of("keyVersion", row.keyVersion);
    }

    @GetMapping("/me")
    @Transactional(readOnly = true)
    public Map<String, Object> mine() {
        java.util.Map<String, Object> out = new java.util.HashMap<>();
        out.put("keys", keys.findById(CurrentUser.id()).map(BundleView::of).orElse(null));
        return out;
    }

    @GetMapping("/{userId}")
    @Transactional(readOnly = true)
    @Operation(summary = "A peer's public bundle, for session establishment")
    public Map<String, Object> peer(@PathVariable UUID userId) {
        users.require(userId);
        UserKeys k = keys.findById(userId).orElseThrow(() -> ApiException.notFound("no_keys", "User has not published keys."));
        return Map.of("userId", userId.toString(), "keys", BundleView.of(k));
    }

    @PutMapping("/backup/blob")
    @Operation(summary = "Store the opaque, client-encrypted recovery backup")
    public Map<String, Boolean> putBackup(@jakarta.validation.Valid @RequestBody BackupRequest body) {
        if (body.blob().length() > MAX_BACKUP_BYTES) throw ApiException.badRequest("Backup blob too large.");
        KeyBackup b = backups.findById(CurrentUser.id()).orElseGet(() -> {
            KeyBackup n = new KeyBackup();
            n.userId = CurrentUser.id();
            return n;
        });
        b.blob = body.blob();
        backups.save(b);
        return Map.of("ok", true);
    }

    @GetMapping("/backup/blob")
    @Transactional(readOnly = true)
    public Map<String, String> getBackup() {
        KeyBackup b = backups.findById(CurrentUser.id()).orElseThrow(() -> ApiException.notFound("no_backup", "No backup stored."));
        return Map.of("blob", b.blob);
    }

    // ── crypto helpers ───────────────────────────────────────────────────────

    static boolean verifyEd25519(byte[] rawPub, byte[] message, byte[] signature) {
        try {
            byte[] spki = new byte[ED25519_SPKI_PREFIX.length + rawPub.length];
            System.arraycopy(ED25519_SPKI_PREFIX, 0, spki, 0, ED25519_SPKI_PREFIX.length);
            System.arraycopy(rawPub, 0, spki, ED25519_SPKI_PREFIX.length, rawPub.length);
            PublicKey pub = KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(spki));
            Signature s = Signature.getInstance("Ed25519");
            s.initVerify(pub);
            s.update(message);
            return s.verify(signature);
        } catch (java.security.GeneralSecurityException e) {
            return false;
        }
    }

    private static byte[] b64(String s, int expectedLen, String what) {
        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(s);
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest("Malformed " + what + ".");
        }
        if (bytes.length != expectedLen) throw ApiException.badRequest(what + " must be " + expectedLen + " bytes.");
        return bytes;
    }

    private static byte[] hex(String h) {
        return java.util.HexFormat.of().parseHex(h);
    }
}
