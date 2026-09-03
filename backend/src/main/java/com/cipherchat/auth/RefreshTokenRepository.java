package com.cipherchat.auth;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

interface RefreshTokenRepository extends JpaRepository<RefreshToken, UUID> {

    Optional<RefreshToken> findByTokenHash(String tokenHash);

    /**
     * Atomic consume: exactly one of N concurrent presenters of the same token
     * gets {@code 1} back. Everyone else sees the row already gone — the
     * replay/theft signal — without any lock or version column.
     */
    @Modifying
    @Query("delete from RefreshToken r where r.tokenHash = :hash and r.expiresAt > :now")
    int consume(@Param("hash") String tokenHash, @Param("now") Instant now);

    @Modifying
    int deleteByTokenHash(String tokenHash);

    List<RefreshToken> findAllByUserIdAndExpiresAtAfterOrderByCreatedAtDesc(UUID userId, Instant now);

    @Modifying
    @Query("delete from RefreshToken r where r.userId = :userId and r.tokenHash <> :keepHash")
    int deleteAllByUserIdExcept(@Param("userId") UUID userId, @Param("keepHash") String keepHash);

    @Modifying
    int deleteByUserId(UUID userId);

    @Modifying
    @Query("delete from RefreshToken r where r.id = :id and r.userId = :userId")
    int deleteByIdAndUserId(@Param("id") UUID id, @Param("userId") UUID userId);

    @Modifying
    @Query("delete from RefreshToken r where r.expiresAt < :now")
    int deleteExpired(@Param("now") Instant now);
}
