package com.cipherchat.notification;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import org.springframework.data.domain.Limit;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.cipherchat.shared.api.ApiException;
import com.cipherchat.shared.security.CurrentUser;

import io.swagger.v3.oas.annotations.tags.Tag;

@RestController
@RequestMapping("/api/v1/notifications")
@Tag(name = "Notifications", description = "Durable per-user inbox")
@Transactional
public class NotificationController {

    public record View(String id, String type, Map<String, Object> payload, boolean read, Instant createdAt) {
        static View of(Notification n) {
            return new View(String.valueOf(n.getId()), n.getType(), n.getPayload(), n.isRead(), n.getCreatedAt());
        }
    }

    private final NotificationRepository notifications;

    public NotificationController(NotificationRepository notifications) {
        this.notifications = notifications;
    }

    @GetMapping
    @Transactional(readOnly = true)
    public List<View> list(@RequestParam(defaultValue = "50") int limit) {
        return notifications.findByUserIdOrderByCreatedAtDesc(CurrentUser.id(), Limit.of(Math.min(Math.max(limit, 1), 200)))
                .stream().map(View::of).toList();
    }

    @GetMapping("/unread-count")
    @Transactional(readOnly = true)
    public Map<String, Long> unread() {
        return Map.of("count", notifications.countByUserIdAndReadFalse(CurrentUser.id()));
    }

    @PostMapping("/{id}/read")
    public Map<String, Boolean> markRead(@PathVariable long id) {
        if (notifications.markRead(id, CurrentUser.id()) == 0
                && notifications.findById(id).filter(n -> n.getUserId().equals(CurrentUser.id())).isEmpty()) {
            throw ApiException.notFound("notification_not_found", "Notification not found.");
        }
        return Map.of("ok", true);
    }

    @PostMapping("/read-all")
    public Map<String, Integer> markAllRead() {
        return Map.of("updated", notifications.markAllRead(CurrentUser.id()));
    }
}
