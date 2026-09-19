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
     * gets {@code 1} back, without any lock or version column. The row is kept
     * (marked used) so a later replay can be recognised and traced to its family.
     */
    @Modifying(clearAutomatically = true)
    @Query("update RefreshToken r set r.usedAt = :now where r.tokenHash = :hash and r.usedAt is null and r.expiresAt > :now")
    int markUsed(@Param("hash") String tokenHash, @Param("now") Instant now);

    Optional<RefreshToken> findByIdAndUserId(UUID id, UUID userId);

    /** Live sessions only: a used row is history, not a session. */
    List<RefreshToken> findAllByUserIdAndUsedAtIsNullAndExpiresAtAfterOrderByCreatedAtDesc(UUID userId, Instant now);

    @Modifying
    @Query("delete from RefreshToken r where r.familyId = :familyId")
    int deleteByFamilyId(@Param("familyId") UUID familyId);

    @Modifying
    @Query("delete from RefreshToken r where r.userId = :userId and r.familyId <> :keepFamily")
    int deleteAllByUserIdExceptFamily(@Param("userId") UUID userId, @Param("keepFamily") UUID keepFamily);

    @Modifying
    int deleteByUserId(UUID userId);

    /** Used rows are only needed while a replay of them is plausible; a week bounds the table. */
    @Modifying
    @Query("delete from RefreshToken r where r.expiresAt < :now or r.usedAt < :usedBefore")
    int deleteExpired(@Param("now") Instant now, @Param("usedBefore") Instant usedBefore);
}
