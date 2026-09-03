package com.cipherchat.auth;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.cipherchat.shared.api.ApiException;

/**
 * TOTP enrollment and verification. Enrollment is two-step — a live code
 * must prove the authenticator actually works before anything is enforced —
 * so a mis-scanned QR can never lock an account.
 */
@Service
@Transactional
public class TwoFactorService {

    private static final Logger log = LoggerFactory.getLogger(TwoFactorService.class);
    private static final String ISSUER = "CipherChat";
    private static final int BACKUP_CODE_COUNT = 8;
    private static final String BACKUP_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"; // no 0/O/1/I
    private static final SecureRandom RANDOM = new SecureRandom();

    public record VerifyResult(boolean ok, boolean usedBackupCode, int backupCodesLeft) {
        static final VerifyResult FAIL = new VerifyResult(false, false, 0);
    }

    private final TwoFactorRepository repo;
    private final SecretBox secretBox;
    private final PasswordEncoder passwordEncoder;

    public TwoFactorService(TwoFactorRepository repo, SecretBox secretBox, PasswordEncoder passwordEncoder) {
        this.repo = repo;
        this.secretBox = secretBox;
        this.passwordEncoder = passwordEncoder;
    }

    @Transactional(readOnly = true)
    public boolean isEnabled(UUID userId) {
        return repo.findById(userId).map(TwoFactor::isEnabled).orElse(false);
    }

    /** Start enrollment (or restart an unconfirmed one). Returns the otpauth URI + raw secret for manual entry. */
    public AuthDtos.TwoFactorSetupResponse setup(UUID userId, String email) {
        Optional<TwoFactor> existing = repo.findById(userId);
        if (existing.map(TwoFactor::isEnabled).orElse(false)) {
            throw ApiException.conflict("2fa_already_enabled", "Two-factor authentication is already enabled.");
        }
        String secret = Totp.generateSecret();
        repo.save(new TwoFactor(userId, secretBox.seal(secret)));
        return new AuthDtos.TwoFactorSetupResponse(Totp.otpauthUri(ISSUER, email, secret), secret);
    }

    /** Confirm with a live code; activates and returns the backup codes exactly once. */
    public List<String> enable(UUID userId, String code) {
        TwoFactor tf = repo.findById(userId)
                .orElseThrow(() -> ApiException.badRequest("2fa_not_setup", "Run setup first."));
        if (tf.isEnabled()) {
            throw ApiException.conflict("2fa_already_enabled", "Two-factor authentication is already enabled.");
        }
        if (!Totp.verify(secretBox.open(tf.getSecretSealed()), code.trim(), Instant.now())) {
            throw ApiException.unauthorized("2fa_bad_code", "That code didn't match — check your authenticator app.");
        }
        List<String> plain = new ArrayList<>();
        String[] hashed = new String[BACKUP_CODE_COUNT];
        for (int i = 0; i < BACKUP_CODE_COUNT; i++) {
            String c = backupCode();
            plain.add(c);
            hashed[i] = passwordEncoder.encode(c);
        }
        tf.enable(hashed);
        log.info("2FA enabled userId={}", userId);
        return plain;
    }

    public void disable(UUID userId, String code) {
        TwoFactor tf = repo.findById(userId).filter(TwoFactor::isEnabled)
                .orElseThrow(() -> ApiException.badRequest("2fa_not_enabled", "Two-factor authentication is not enabled."));
        if (!verify(tf, code).ok()) {
            throw ApiException.unauthorized("2fa_bad_code", "That code didn't match.");
        }
        repo.delete(tf);
        log.info("2FA disabled userId={}", userId);
    }

    /** Accepts a TOTP code or a single-use backup code (which is burned on success). */
    public VerifyResult verifyLogin(UUID userId, String code) {
        return repo.findById(userId).filter(TwoFactor::isEnabled).map(tf -> verify(tf, code)).orElse(VerifyResult.FAIL);
    }

    private VerifyResult verify(TwoFactor tf, String code) {
        String trimmed = code.trim();
        if (Totp.verify(secretBox.open(tf.getSecretSealed()), trimmed, Instant.now())) {
            return new VerifyResult(true, false, tf.getBackupCodes().length);
        }
        String candidate = trimmed.toUpperCase();
        String[] codes = tf.getBackupCodes();
        for (int i = 0; i < codes.length; i++) {
            if (passwordEncoder.matches(candidate, codes[i])) {
                List<String> remaining = new ArrayList<>(Arrays.asList(codes));
                remaining.remove(i);
                tf.setBackupCodes(remaining.toArray(String[]::new));
                return new VerifyResult(true, true, remaining.size());
            }
        }
        return VerifyResult.FAIL;
    }

    private static String backupCode() {
        StringBuilder sb = new StringBuilder(9);
        for (int i = 0; i < 8; i++) {
            if (i == 4) sb.append('-');
            sb.append(BACKUP_ALPHABET.charAt(RANDOM.nextInt(BACKUP_ALPHABET.length())));
        }
        return sb.toString();
    }
}
