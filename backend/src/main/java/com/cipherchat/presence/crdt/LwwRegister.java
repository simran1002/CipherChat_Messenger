package com.cipherchat.presence.crdt;

import java.util.Objects;

/**
 * Last-write-wins register for a single mutable field (status, status note, display name — anything
 * where "the newest write replaces the field" is the whole semantics, unlike a counter). Ordered by
 * {@link HlcTimestamp}, not a raw {@code Instant}, specifically so that a causally-later write from a
 * clock-skewed replica still wins — see {@link HlcTimestamp}'s Javadoc for why that distinction matters.
 *
 * <p>{@code merge} keeps whichever side has the greater timestamp; equal timestamps (only possible for
 * two copies of the exact same write) keep either side, so merge stays idempotent.
 */
public final class LwwRegister<T> {

    private final T value;
    private final HlcTimestamp timestamp;

    public static <T> LwwRegister<T> initial(T value, HlcTimestamp timestamp) {
        return new LwwRegister<>(value, timestamp);
    }

    private LwwRegister(T value, HlcTimestamp timestamp) {
        this.value = value;
        this.timestamp = timestamp;
    }

    /** A new local write. Always wins over the current value — it is, by definition, the newest thing
     *  this replica knows, and the caller is expected to have drawn {@code timestamp} from a clock whose
     *  {@code now()}/{@code update()} calls already account for every remote timestamp seen so far. */
    public LwwRegister<T> set(T value, HlcTimestamp timestamp) {
        return new LwwRegister<>(value, timestamp);
    }

    public LwwRegister<T> merge(LwwRegister<T> other) {
        return timestamp.compareTo(other.timestamp) >= 0 ? this : other;
    }

    public T value() {
        return value;
    }

    public HlcTimestamp timestamp() {
        return timestamp;
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof LwwRegister<?> r && Objects.equals(value, r.value) && timestamp.equals(r.timestamp);
    }

    @Override
    public int hashCode() {
        return Objects.hash(value, timestamp);
    }
}
