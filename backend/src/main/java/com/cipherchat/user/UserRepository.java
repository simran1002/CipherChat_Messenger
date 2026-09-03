package com.cipherchat.user;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface UserRepository extends JpaRepository<User, UUID> {

    /** Uses the lower(email) expression index — derived {@code IgnoreCase} would emit upper(). */
    @Query("select u from User u where lower(u.email) = lower(:email)")
    Optional<User> findByEmail(@Param("email") String email);

    @Query("select (count(u) > 0) from User u where lower(u.email) = lower(:email)")
    boolean existsByEmail(@Param("email") String email);

    List<User> findAllByIdIn(Collection<UUID> ids);

    /** Directory listing for "start a DM" — everyone but the caller, by name. */
    List<User> findAllByIdNotOrderByNameAsc(UUID excludeId);

    /** Presence bookkeeping is best-effort and must never bump the optimistic-lock version. */
    @Modifying
    @Query("update User u set u.online = :online, u.lastSeen = case when :online = true then u.lastSeen else CURRENT_TIMESTAMP end where u.id = :id")
    int setOnline(@Param("id") UUID id, @Param("online") boolean online);
}
