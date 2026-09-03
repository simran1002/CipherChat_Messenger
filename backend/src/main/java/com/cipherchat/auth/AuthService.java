package com.cipherchat.auth;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.cipherchat.auth.AuthDtos.LoginResponse;
import com.cipherchat.shared.api.ApiException;
import com.cipherchat.shared.events.AuditEvents.Audited;
import com.cipherchat.shared.events.AuditPublisher;
import com.cipherchat.shared.security.AuthenticatedUser;
import com.cipherchat.user.UserService;
import com.cipherchat.user.UserView;

/**
 * Orchestrates the auth flows. Every successful sign-in ends the same way:
 * a 15-minute access token in the body and a fresh refresh token in the
 * cookie. The password alone never yields a session for a 2FA account —
 * only a scoped pending token that {@link JwtService} refuses everywhere else.
 *
 * <p>Security-relevant outcomes are published as audit events. Successes
 * join the transaction (no trace unless the action committed); failures are
 * published detached, because the exception that reports them also rolls
 * the transaction back.
 */
@Service
@Transactional
public class AuthService {

    private static final Logger log = LoggerFactory.getLogger(AuthService.class);

    private final UserService users;
    private final JwtService jwt;
    private final RefreshTokenService refreshTokens;
    private final RefreshCookie cookie;
    private final TwoFactorService twoFactor;
    private final AuditPublisher audit;

    public AuthService(UserService users, JwtService jwt, RefreshTokenService refreshTokens,
                       RefreshCookie cookie, TwoFactorService twoFactor, AuditPublisher audit) {
        this.users = users;
        this.jwt = jwt;
        this.refreshTokens = refreshTokens;
        this.cookie = cookie;
        this.twoFactor = twoFactor;
        this.audit = audit;
    }

    public LoginResponse register(String name, String email, String password, HttpServletRequest req, HttpServletResponse res) {
        UserView user = users.register(name, email, password);
        log.info("User registered userId={}", user.id());
        audit.publish(Audited.of(user.id(), "user.registered", "user", user.id().toString(), Map.of(), req.getRemoteAddr()));
        return LoginResponse.session("User [" + user.name() + "] registered successfully!", startSession(user, req, res), user);
    }

    public LoginResponse login(String email, String password, HttpServletRequest req, HttpServletResponse res) {
        UserView user = users.authenticate(email, password).orElseThrow(() -> {
            audit.publishDetached(Audited.of(null, "user.login_failed", "user", null,
                    Map.of("email", email.toLowerCase()), req.getRemoteAddr()));
            return ApiException.unauthorized("bad_credentials", "Email and password did not match.");
        });
        if (twoFactor.isEnabled(user.id())) {
            // No cookie, no online flag — nothing about the account changes until the second factor.
            return LoginResponse.challenge(jwt.issueTwoFactorPendingToken(user.id()));
        }
        log.info("User logged in userId={}", user.id());
        audit.publish(Audited.of(user.id(), "user.login", "user", user.id().toString(), Map.of("2fa", false), req.getRemoteAddr()));
        return LoginResponse.session("User logged in successfully!", startSession(user, req, res), user);
    }

    public LoginResponse completeTwoFactorLogin(String pendingToken, String code, HttpServletRequest req, HttpServletResponse res) {
        UUID userId = jwt.parseTwoFactorPendingToken(pendingToken)
                .orElseThrow(() -> ApiException.unauthorized("2fa_pending_invalid", "Sign-in expired — enter your password again."));
        TwoFactorService.VerifyResult result = twoFactor.verifyLogin(userId, code);
        if (!result.ok()) {
            audit.publishDetached(Audited.of(userId, "user.login_failed", "user", userId.toString(),
                    Map.of("stage", "2fa"), req.getRemoteAddr()));
            throw ApiException.unauthorized("2fa_bad_code", "That code didn't match.");
        }
        UserView user = users.require(userId);
        log.info("User logged in (2FA) userId={} backupCode={}", userId, result.usedBackupCode());
        audit.publish(Audited.of(userId, "user.login", "user", userId.toString(),
                Map.of("2fa", true, "backupCode", result.usedBackupCode()), req.getRemoteAddr()));
        String token = startSession(user, req, res);
        return result.usedBackupCode()
                ? LoginResponse.session("User logged in successfully!", token, user, result.backupCodesLeft())
                : LoginResponse.session("User logged in successfully!", token, user);
    }

    /** Rotate the refresh cookie; mint a new access token. 401 when the cookie is missing/expired/replayed. */
    public String refresh(HttpServletRequest req, HttpServletResponse res) {
        String raw = cookie.read(req).orElseThrow(() -> ApiException.unauthorized("refresh_invalid", "Refresh token invalid or expired."));
        UUID userId = refreshTokens.ownerOf(raw).orElse(null);
        var issued = refreshTokens.rotate(raw, req.getRemoteAddr()).orElseThrow(() -> {
            cookie.clear(res);
            // A presented-but-unknown refresh token is the signature of token theft + replay.
            audit.publishDetached(Audited.of(userId, "user.refresh_rejected", "user",
                    userId == null ? null : userId.toString(), Map.of(), req.getRemoteAddr()));
            return ApiException.unauthorized("refresh_invalid", "Refresh token invalid or expired.");
        });
        cookie.set(res, issued.rawToken());
        UserView user = users.require(userId);
        return jwt.issueAccessToken(principal(user));
    }

    public void logout(UUID userId, HttpServletRequest req, HttpServletResponse res) {
        cookie.read(req).ifPresent(refreshTokens::revoke);
        cookie.clear(res);
        if (userId != null) {
            audit.publish(Audited.of(userId, "user.logout", "user", userId.toString(), Map.of(), req.getRemoteAddr()));
        }
    }

    /** Changing the password signs out every OTHER device — the classic post-compromise step. */
    public void changePassword(UUID userId, String current, String next, HttpServletRequest req) {
        users.changePassword(userId, current, next);
        int revoked = refreshTokens.revokeOthers(userId, cookie.read(req).orElse(null));
        log.info("Password changed userId={} otherSessionsRevoked={}", userId, revoked);
        audit.publish(Audited.of(userId, "user.password_changed", "user", userId.toString(),
                Map.of("otherSessionsRevoked", revoked), req.getRemoteAddr()));
    }

    public List<RefreshTokenService.SessionView> sessions(UUID userId, HttpServletRequest req) {
        return refreshTokens.sessions(userId, cookie.read(req).orElse(null));
    }

    public boolean revokeSession(UUID userId, UUID sessionId, HttpServletRequest req) {
        boolean revoked = refreshTokens.revokeSession(userId, sessionId);
        if (revoked) {
            audit.publish(Audited.of(userId, "user.session_revoked", "session", sessionId.toString(), Map.of(), req.getRemoteAddr()));
        }
        return revoked;
    }

    public int revokeOtherSessions(UUID userId, HttpServletRequest req) {
        int n = refreshTokens.revokeOthers(userId, cookie.read(req).orElse(null));
        audit.publish(Audited.of(userId, "user.sessions_revoked", "user", userId.toString(), Map.of("count", n), req.getRemoteAddr()));
        return n;
    }

    public List<String> enableTwoFactor(UUID userId, String code, HttpServletRequest req) {
        List<String> backupCodes = twoFactor.enable(userId, code);
        audit.publish(Audited.of(userId, "user.2fa_enabled", "user", userId.toString(), Map.of(), req.getRemoteAddr()));
        return backupCodes;
    }

    public void disableTwoFactor(UUID userId, String password, String code, HttpServletRequest req) {
        if (!users.verifyPassword(userId, password)) {
            audit.publishDetached(Audited.of(userId, "user.2fa_disable_failed", "user", userId.toString(), Map.of(), req.getRemoteAddr()));
            throw ApiException.unauthorized("bad_credentials", "Password is incorrect.");
        }
        twoFactor.disable(userId, code);
        audit.publish(Audited.of(userId, "user.2fa_disabled", "user", userId.toString(), Map.of(), req.getRemoteAddr()));
    }

    private String startSession(UserView user, HttpServletRequest req, HttpServletResponse res) {
        cookie.set(res, refreshTokens.issue(user.id(), req.getRemoteAddr()).rawToken());
        users.setOnline(user.id(), true);
        return jwt.issueAccessToken(principal(user));
    }

    static AuthenticatedUser principal(UserView user) {
        return new AuthenticatedUser(user.id(), user.email(), user.role().name());
    }
}
