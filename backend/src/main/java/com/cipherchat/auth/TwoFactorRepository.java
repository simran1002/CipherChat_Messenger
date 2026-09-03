package com.cipherchat.auth;

import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

interface TwoFactorRepository extends JpaRepository<TwoFactor, UUID> {
}
