package com.cipherchat.user;

import java.util.Arrays;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;

/** Stored and serialized as the lowercase snake value the clients already use. */
public enum PresenceStatus {
    AVAILABLE("available"),
    CODING("coding"),
    IN_MEETING("in_meeting"),
    FOCUSING("focusing"),
    DRIVING("driving"),
    AWAY("away"),
    BUSY("busy");

    private final String value;

    PresenceStatus(String value) {
        this.value = value;
    }

    @com.fasterxml.jackson.annotation.JsonValue
    public String value() {
        return value;
    }

    @com.fasterxml.jackson.annotation.JsonCreator
    public static PresenceStatus fromValue(String value) {
        return Arrays.stream(values())
                .filter(s -> s.value.equals(value))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unknown presence status: " + value));
    }

    @Converter(autoApply = true)
    public static class JpaConverter implements AttributeConverter<PresenceStatus, String> {
        @Override
        public String convertToDatabaseColumn(PresenceStatus attribute) {
            return attribute == null ? null : attribute.value;
        }

        @Override
        public PresenceStatus convertToEntityAttribute(String dbData) {
            return dbData == null ? null : fromValue(dbData);
        }
    }
}
