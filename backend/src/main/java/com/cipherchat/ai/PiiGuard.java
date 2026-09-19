package com.cipherchat.ai;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Server-side second line for the redacted AI path. The client redacts before anything leaves
 * the device; this guard independently re-scans what arrived and the endpoint refuses (422) if
 * any structured identifier survived. It is intentionally simpler than the client redactor —
 * it never needs to reverse anything, only to say "this still looks like PII".
 *
 * Placeholder tokens such as {@code [PERSON_1]} are the expected shape and never match.
 */
final class PiiGuard {

    private record Detector(String name, Pattern pattern, boolean luhn) {
    }

    private static final List<Detector> DETECTORS = List.of(
            new Detector("EMAIL", Pattern.compile("\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b"), false),
            new Detector("CARD", Pattern.compile("\\b(?:\\d[ -]?){12,18}\\d\\b"), true),
            new Detector("GOV_ID", Pattern.compile("\\b\\d{3}-\\d{2}-\\d{4}\\b|\\b\\d{4}\\s\\d{4}\\s\\d{4}\\b|\\b[A-Z]{5}\\d{4}[A-Z]\\b"), false),
            new Detector("MRN", Pattern.compile("\\b(?:MRN|UHID|Patient\\s?ID)\\s*[:#-]?\\s*[A-Z0-9-]{4,}\\b", Pattern.CASE_INSENSITIVE), false),
            new Detector("PHONE", Pattern.compile("(?<![\\w.])\\+?\\d[\\d\\s().-]{8,16}\\d(?!\\w|\\.\\d)"), false));

    private PiiGuard() {
    }

    /** Names of the detectors that fired, in a stable order; empty when the text is clean. */
    static Set<String> scan(String text) {
        Set<String> hits = new LinkedHashSet<>();
        if (text == null || text.isEmpty()) return hits;
        for (Detector d : DETECTORS) {
            Matcher m = d.pattern().matcher(text);
            while (m.find()) {
                String match = m.group();
                if (d.luhn() && !luhnValid(match)) continue;
                if (d.name().equals("PHONE") && digits(match) < 10) continue;
                hits.add(d.name());
                break;
            }
        }
        return hits;
    }

    static boolean luhnValid(String s) {
        int sum = 0;
        int count = 0;
        boolean dbl = false;
        for (int i = s.length() - 1; i >= 0; i--) {
            char c = s.charAt(i);
            if (c < '0' || c > '9') continue;
            int n = c - '0';
            if (dbl) {
                n *= 2;
                if (n > 9) n -= 9;
            }
            sum += n;
            dbl = !dbl;
            count++;
        }
        return count >= 13 && count <= 19 && sum % 10 == 0;
    }

    private static int digits(String s) {
        int n = 0;
        for (int i = 0; i < s.length(); i++) {
            if (Character.isDigit(s.charAt(i))) n++;
        }
        return n;
    }
}
