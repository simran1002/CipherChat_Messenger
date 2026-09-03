package com.cipherchat.analytics;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import io.swagger.v3.oas.annotations.tags.Tag;

/** Admin overview from aggregate SQL. Every query is an index-only count — safe to poll. */
@RestController
@RequestMapping("/api/v1/admin/analytics")
@Tag(name = "Admin · Analytics", description = "Content-free usage overview")
@Transactional(readOnly = true)
public class AnalyticsController {

    public record Overview(long users, long onlineNow, long chatrooms, long roomMessages, long directMessages,
                           long encryptedDirectMessages, long messagesLast24h, List<Map<String, Object>> messagesPerDay) {
    }

    private final JdbcClient jdbc;

    public AnalyticsController(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/overview")
    public Overview overview() {
        Instant dayAgo = Instant.now().minus(1, ChronoUnit.DAYS);
        Instant weekAgo = Instant.now().minus(7, ChronoUnit.DAYS);
        return new Overview(
                count("select count(*) from users"),
                count("select count(*) from users where online"),
                count("select count(*) from chatrooms"),
                count("select count(*) from messages"),
                count("select count(*) from dm_messages"),
                count("select count(*) from dm_messages where type = 'e2ee/v1'"),
                jdbc.sql("select (select count(*) from messages where created_at > :t) + (select count(*) from dm_messages where created_at > :t)")
                        .param("t", dayAgo).query(Long.class).single(),
                jdbc.sql("""
                        select d::date as day, coalesce(r.n, 0) + coalesce(m.n, 0) as messages
                        from generate_series(date_trunc('day', :from::timestamptz), date_trunc('day', now()), interval '1 day') d
                        left join (select date_trunc('day', created_at) day, count(*) n from messages where created_at > :from group by 1) r on r.day = d
                        left join (select date_trunc('day', created_at) day, count(*) n from dm_messages where created_at > :from group by 1) m on m.day = d
                        order by d""").param("from", weekAgo).query().listOfRows());
    }

    private long count(String sql) {
        return jdbc.sql(sql).query(Long.class).single();
    }
}
