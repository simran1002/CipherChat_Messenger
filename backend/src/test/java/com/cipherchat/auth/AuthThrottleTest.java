package com.cipherchat.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyDouble;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;

import com.cipherchat.shared.api.ApiException;
import com.cipherchat.shared.infra.RedisRateLimiter;

class AuthThrottleTest {

    private final RedisRateLimiter limiter = mock(RedisRateLimiter.class);
    private final AuthThrottle throttle = new AuthThrottle(limiter, 100, 30, 10);

    @Test
    void perAddressBudgetIsCapacityOverTheFifteenMinuteWindow() {
        when(limiter.tryAcquire(anyString(), anyInt(), anyDouble())).thenReturn(true);

        throttle.credentials("203.0.113.9");

        verify(limiter).tryAcquire("rl:auth:ip:203.0.113.9", 100, 100 / 900.0);
    }

    @Test
    void theTwoFactorBudgetIsPerAccount_notPerAddress() {
        when(limiter.tryAcquire(anyString(), anyInt(), anyDouble())).thenReturn(true);
        UUID user = UUID.randomUUID();

        throttle.twoFactor(user);

        verify(limiter).tryAcquire("rl:auth:2fa:" + user, 10, 10 / 300.0);
    }

    @Test
    void loginKeysNeverContainTheEmailAddress_andIgnoreCaseAndWhitespace() {
        when(limiter.tryAcquire(anyString(), anyInt(), anyDouble())).thenReturn(true);

        throttle.login("198.51.100.4", "  Alice@Example.COM ");
        throttle.login("198.51.100.4", "alice@example.com");

        ArgumentCaptor<String> keys = ArgumentCaptor.forClass(String.class);
        verify(limiter, org.mockito.Mockito.atLeast(4)).tryAcquire(keys.capture(), anyInt(), anyDouble());
        var perAccount = keys.getAllValues().stream().filter(k -> k.startsWith("rl:auth:login:")).toList();
        assertThat(perAccount).hasSize(2);
        assertThat(perAccount.get(0)).isEqualTo(perAccount.get(1));
        assertThat(perAccount.get(0)).doesNotContain("alice").doesNotContain("example");
    }

    @Test
    void anExhaustedBucketBecomesA429WithAStableCode() {
        when(limiter.tryAcquire(eq("rl:auth:refresh:10.0.0.1"), anyInt(), anyDouble())).thenReturn(false);

        assertThatThrownBy(() -> throttle.refresh("10.0.0.1"))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.status()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
                    assertThat(e.code()).isEqualTo("rate_limited");
                });
    }
}
