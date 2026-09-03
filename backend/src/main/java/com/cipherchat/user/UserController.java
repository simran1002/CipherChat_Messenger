package com.cipherchat.user;

import java.util.List;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.cipherchat.shared.security.CurrentUser;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;

@RestController
@RequestMapping("/api/v1/users")
@Tag(name = "Users", description = "Profiles, directory, presence status")
public class UserController {

    private final UserService users;

    public UserController(UserService users) {
        this.users = users;
    }

    public record UpdateProfileRequest(
            @Size(min = 1, max = 50) String name,
            @Size(max = 160) String bio,
            @Size(max = 2048) String dp) {
    }

    public record PresenceRequest(PresenceStatus presenceStatus, @Size(max = 80) String presenceNote) {
    }

    @GetMapping("/me")
    @Operation(summary = "The caller's own profile")
    public UserView me() {
        return users.require(CurrentUser.id());
    }

    @PatchMapping("/me")
    @Operation(summary = "Update name, bio or avatar URL")
    public UserView updateMe(@Valid @RequestBody UpdateProfileRequest body) {
        return users.updateProfile(CurrentUser.id(), body.name(), body.bio(), body.dp());
    }

    @PutMapping("/me/presence")
    @Operation(summary = "Set presence status + note (also broadcast over WebSocket)")
    public UserView presence(@Valid @RequestBody PresenceRequest body) {
        return users.setPresence(CurrentUser.id(), body.presenceStatus(), body.presenceNote());
    }

    @GetMapping
    @Operation(summary = "Directory of every other user (for starting a DM)")
    public List<UserView> directory() {
        return users.directoryExcluding(CurrentUser.id());
    }

    @GetMapping("/{id}")
    @Operation(summary = "A user's public profile")
    public UserView get(@PathVariable UUID id) {
        return users.require(id);
    }
}
