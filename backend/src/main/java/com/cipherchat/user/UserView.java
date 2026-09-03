package com.cipherchat.user;

import java.time.Instant;
import java.util.UUID;

/** Public projection of a user — what other modules and API responses see. Never the password hash. */
public record UserView(
        UUID id,
        String name,
        String email,
        String dp,
        String bio,
        PresenceStatus presenceStatus,
        String presenceNote,
        boolean isOnline,
        Instant lastSeen,
        User.Role role) {

    static UserView of(User u) {
        return new UserView(u.getId(), u.getName(), u.getEmail(), u.getDp(), u.getBio(),
                u.getPresenceStatus(), u.getPresenceNote(), u.isOnline(), u.getLastSeen(), u.getRole());
    }

    /** The subset broadcast in rosters and attached to messages. */
    public record Summary(UUID id, String name, String dp) {
        static Summary of(User u) {
            return new Summary(u.getId(), u.getName(), u.getDp());
        }
    }
}
