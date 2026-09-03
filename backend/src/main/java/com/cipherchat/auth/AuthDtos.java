package com.cipherchat.auth;

import java.util.List;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import com.cipherchat.user.UserView;

/** Request/response shapes for the auth API. Immutable records; validation is declarative. */
public final class AuthDtos {

    private AuthDtos() {
    }

    public record RegisterRequest(
            @NotBlank @Size(max = 50) String name,
            @NotBlank @Email @Size(max = 254) String email,
            @NotBlank @Size(min = 8, max = 128) String password) {
    }

    public record LoginRequest(@NotBlank @Email String email, @NotBlank String password) {
    }

    public record TwoFactorLoginRequest(@NotBlank String pendingToken, @NotBlank @Size(max = 16) String code) {
    }

    public record ChangePasswordRequest(@NotBlank String currentPassword, @NotBlank @Size(min = 8, max = 128) String newPassword) {
    }

    public record TwoFactorEnableRequest(@NotBlank @Size(min = 6, max = 6) String code) {
    }

    public record TwoFactorDisableRequest(@NotBlank String password, @NotBlank @Size(max = 16) String code) {
    }

    /** Either a full session ({@code token} + {@code user}) or a 2FA challenge ({@code requires2fa} + {@code pendingToken}). */
    public record LoginResponse(String message, String token, UserView user, Boolean requires2fa, String pendingToken,
                                Integer backupCodesLeft) {
        static LoginResponse session(String message, String token, UserView user) {
            return new LoginResponse(message, token, user, null, null, null);
        }

        static LoginResponse session(String message, String token, UserView user, int backupCodesLeft) {
            return new LoginResponse(message, token, user, null, null, backupCodesLeft);
        }

        static LoginResponse challenge(String pendingToken) {
            return new LoginResponse("Two-factor code required.", null, null, true, pendingToken, null);
        }
    }

    public record TokenResponse(String token) {
    }

    public record TwoFactorSetupResponse(String otpauthUrl, String secret) {
    }

    public record TwoFactorEnableResponse(String message, List<String> backupCodes) {
    }

    public record MessageResponse(String message) {
    }
}
