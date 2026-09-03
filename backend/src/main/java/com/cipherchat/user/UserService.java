package com.cipherchat.user;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;

import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.cipherchat.shared.api.ApiException;

/**
 * The user module's public API. Other modules resolve identities through
 * this service (and only this service) — they never touch {@link UserRepository}.
 */
@Service
@Transactional
public class UserService {

    private final UserRepository users;
    private final PasswordEncoder passwordEncoder;

    public UserService(UserRepository users, PasswordEncoder passwordEncoder) {
        this.users = users;
        this.passwordEncoder = passwordEncoder;
    }

    public UserView register(String name, String email, String rawPassword) {
        if (users.existsByEmail(email)) {
            throw ApiException.conflict("email_taken", "User with this email already exists.");
        }
        User user = users.save(new User(name.trim(), email.trim(), passwordEncoder.encode(rawPassword)));
        return UserView.of(user);
    }

    /** Constant-time-safe: a missing user still runs one BCrypt round so timing doesn't reveal existence. */
    @Transactional(readOnly = true)
    public Optional<UserView> authenticate(String email, String rawPassword) {
        Optional<User> user = users.findByEmail(email);
        String hash = user.map(User::getPasswordHash)
                .orElse("$2a$12$C6UzMDM.H6dfI/f/IKcEeO7yCeSwcZfEzrQ9nzfrX9mZyUZY3H4uK"); // dummy hash
        boolean ok = passwordEncoder.matches(rawPassword, hash);
        return ok ? user.map(UserView::of) : Optional.empty();
    }

    @Transactional(readOnly = true)
    public UserView require(UUID id) {
        return users.findById(id).map(UserView::of)
                .orElseThrow(() -> ApiException.notFound("user_not_found", "User not found."));
    }

    @Transactional(readOnly = true)
    public Optional<UserView> find(UUID id) {
        return users.findById(id).map(UserView::of);
    }

    @Transactional(readOnly = true)
    public Optional<UserView> findByEmail(String email) {
        return users.findByEmail(email).map(UserView::of);
    }

    /** Batch lookup for message enrichment — one query, not N. */
    @Transactional(readOnly = true)
    public Map<UUID, UserView.Summary> summaries(Collection<UUID> ids) {
        if (ids.isEmpty()) return Map.of();
        return users.findAllByIdIn(ids).stream()
                .collect(Collectors.toMap(User::getId, UserView.Summary::of, (a, b) -> a));
    }

    /** Full views in one query — for member lists, where email and online state are shown. */
    @Transactional(readOnly = true)
    public Map<UUID, UserView> views(Collection<UUID> ids) {
        if (ids.isEmpty()) return Map.of();
        return users.findAllByIdIn(ids).stream()
                .collect(Collectors.toMap(User::getId, UserView::of, (a, b) -> a));
    }

    @Transactional(readOnly = true)
    public List<UserView> directoryExcluding(UUID callerId) {
        return users.findAllByIdNotOrderByNameAsc(callerId).stream().map(UserView::of).toList();
    }

    public UserView updateProfile(UUID id, String name, String bio, String dp) {
        User user = load(id);
        if (name != null && !name.isBlank()) user.rename(name.trim());
        if (bio != null) user.setBio(bio.length() > 160 ? bio.substring(0, 160) : bio);
        if (dp != null) user.setDp(dp);
        return UserView.of(user);
    }

    public void changePassword(UUID id, String currentPassword, String newPassword) {
        User user = load(id);
        if (!passwordEncoder.matches(currentPassword, user.getPasswordHash())) {
            throw ApiException.unauthorized("bad_credentials", "Current password is incorrect.");
        }
        user.changePassword(passwordEncoder.encode(newPassword));
    }

    public boolean verifyPassword(UUID id, String rawPassword) {
        return passwordEncoder.matches(rawPassword, load(id).getPasswordHash());
    }

    public UserView setPresence(UUID id, PresenceStatus status, String note) {
        User user = load(id);
        user.setPresence(status, note == null ? null : note.substring(0, Math.min(80, note.length())));
        return UserView.of(user);
    }

    public void setOnline(UUID id, boolean online) {
        users.setOnline(id, online);
    }

    private User load(UUID id) {
        return users.findById(id).orElseThrow(() -> ApiException.notFound("user_not_found", "User not found."));
    }

    /** Small helper for callers that need a name→id style map built once. */
    public static <T> Map<UUID, T> indexById(Collection<T> items, Function<T, UUID> idOf) {
        return items.stream().collect(Collectors.toMap(idOf, Function.identity(), (a, b) -> a));
    }

    public Instant now() {
        return Instant.now();
    }
}
