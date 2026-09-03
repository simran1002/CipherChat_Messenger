package com.cipherchat.auth;

import java.util.List;
import java.util.UUID;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.cipherchat.auth.AuthDtos.ChangePasswordRequest;
import com.cipherchat.auth.AuthDtos.LoginRequest;
import com.cipherchat.auth.AuthDtos.LoginResponse;
import com.cipherchat.auth.AuthDtos.MessageResponse;
import com.cipherchat.auth.AuthDtos.RegisterRequest;
import com.cipherchat.auth.AuthDtos.TokenResponse;
import com.cipherchat.auth.AuthDtos.TwoFactorDisableRequest;
import com.cipherchat.auth.AuthDtos.TwoFactorEnableRequest;
import com.cipherchat.auth.AuthDtos.TwoFactorEnableResponse;
import com.cipherchat.auth.AuthDtos.TwoFactorLoginRequest;
import com.cipherchat.auth.AuthDtos.TwoFactorSetupResponse;
import com.cipherchat.shared.api.ApiException;
import com.cipherchat.shared.security.AuthenticatedUser;
import com.cipherchat.shared.security.CurrentUser;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;

@RestController
@RequestMapping("/api/v1/auth")
@Tag(name = "Auth", description = "Registration, login, refresh, sessions, two-factor")
public class AuthController {

    private final AuthService auth;
    private final TwoFactorService twoFactor;

    public AuthController(AuthService auth, TwoFactorService twoFactor) {
        this.auth = auth;
        this.twoFactor = twoFactor;
    }

    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "Create an account; returns an access token and sets the refresh cookie")
    public LoginResponse register(@Valid @RequestBody RegisterRequest body, HttpServletRequest req, HttpServletResponse res) {
        return auth.register(body.name(), body.email(), body.password(), req, res);
    }

    @PostMapping("/login")
    @Operation(summary = "Password login — returns a session, or a 2FA challenge with a pending token")
    public LoginResponse login(@Valid @RequestBody LoginRequest body, HttpServletRequest req, HttpServletResponse res) {
        return auth.login(body.email(), body.password(), req, res);
    }

    @PostMapping("/login/2fa")
    @Operation(summary = "Second step of login: pending token + TOTP or backup code")
    public LoginResponse loginTwoFactor(@Valid @RequestBody TwoFactorLoginRequest body, HttpServletRequest req, HttpServletResponse res) {
        return auth.completeTwoFactorLogin(body.pendingToken(), body.code(), req, res);
    }

    @PostMapping("/refresh")
    @Operation(summary = "Rotate the refresh cookie and mint a new 15-minute access token")
    public TokenResponse refresh(HttpServletRequest req, HttpServletResponse res) {
        return new TokenResponse(auth.refresh(req, res));
    }

    @PostMapping("/logout")
    @Operation(summary = "Revoke this session's refresh token")
    public MessageResponse logout(HttpServletRequest req, HttpServletResponse res) {
        auth.logout(CurrentUser.find().map(AuthenticatedUser::id).orElse(null), req, res);
        return new MessageResponse("Logged out.");
    }

    @PostMapping("/password")
    @Operation(summary = "Change password; signs out every other device")
    public MessageResponse changePassword(@Valid @RequestBody ChangePasswordRequest body, HttpServletRequest req) {
        auth.changePassword(CurrentUser.id(), body.currentPassword(), body.newPassword(), req);
        return new MessageResponse("Password changed. Other sessions were signed out.");
    }

    // ── Sessions (one refresh-token row = one signed-in device) ──────────────

    @GetMapping("/sessions")
    @Operation(summary = "Every live session for the caller, current one flagged")
    public List<RefreshTokenService.SessionView> sessions(HttpServletRequest req) {
        return auth.sessions(CurrentUser.id(), req);
    }

    @DeleteMapping("/sessions")
    @Operation(summary = "Sign out everywhere else")
    public MessageResponse revokeOthers(HttpServletRequest req) {
        int n = auth.revokeOtherSessions(CurrentUser.id(), req);
        return new MessageResponse("Signed out of " + n + " other session(s).");
    }

    @DeleteMapping("/sessions/{sessionId}")
    @Operation(summary = "Revoke one session (owner-scoped)")
    public MessageResponse revokeSession(@PathVariable UUID sessionId, HttpServletRequest req) {
        if (!auth.revokeSession(CurrentUser.id(), sessionId, req)) {
            throw ApiException.notFound("session_not_found", "Session not found.");
        }
        return new MessageResponse("Session revoked.");
    }

    // ── Two-factor ───────────────────────────────────────────────────────────

    @GetMapping("/2fa/status")
    @Operation(summary = "Whether the caller has two-factor authentication enabled")
    public java.util.Map<String, Boolean> twoFactorStatus() {
        return java.util.Map.of("enabled", twoFactor.isEnabled(CurrentUser.id()));
    }

    @PostMapping("/2fa/setup")
    @Operation(summary = "Start TOTP enrollment — returns the otpauth URI for the QR code")
    public TwoFactorSetupResponse setupTwoFactor() {
        AuthenticatedUser me = CurrentUser.require();
        return twoFactor.setup(me.id(), me.email());
    }

    @PostMapping("/2fa/enable")
    @Operation(summary = "Confirm enrollment with a live code; returns backup codes exactly once")
    public TwoFactorEnableResponse enableTwoFactor(@Valid @RequestBody TwoFactorEnableRequest body, HttpServletRequest req) {
        return new TwoFactorEnableResponse("Two-factor authentication enabled.", auth.enableTwoFactor(CurrentUser.id(), body.code(), req));
    }

    @PostMapping("/2fa/disable")
    @Operation(summary = "Disable 2FA — requires the password AND a current or backup code")
    public MessageResponse disableTwoFactor(@Valid @RequestBody TwoFactorDisableRequest body, HttpServletRequest req) {
        auth.disableTwoFactor(CurrentUser.id(), body.password(), body.code(), req);
        return new MessageResponse("Two-factor authentication disabled.");
    }
}
