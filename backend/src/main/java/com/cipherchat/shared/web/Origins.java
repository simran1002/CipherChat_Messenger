package com.cipherchat.shared.web;

import java.util.Arrays;
import java.util.List;

/**
 * Parses the comma-separated allow-list behind {@code CORS_ALLOWED_ORIGINS}. Entries without a
 * scheme are taken as {@code https://host}: deployment blueprints (Render's {@code fromService
 * … property: host}) can inject another service's hostname but not its scheme, and an origin must
 * carry one. Whitespace and trailing slashes are dropped; blanks are ignored.
 */
public final class Origins {

    private Origins() {
    }

    public static List<String> parse(String csv) {
        if (csv == null) return List.of();
        return Arrays.stream(csv.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .map(Origins::normalise)
                .toList();
    }

    static String normalise(String entry) {
        String e = entry.replaceAll("/+$", "");
        if (e.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) return e;
        return "https://" + e;
    }
}
