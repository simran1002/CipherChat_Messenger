/**
 * React binding for the E2EE identity state machine.
 * Thin wrapper over e2eeService.ensureReady() — pages read `status` and
 * call `refresh()` after the setup gate resolves.
 */
import { useCallback, useEffect, useState } from "react";
import { AxiosError } from "axios";
import e2eeService, { type E2EEStatus } from "../services/E2EEService";

/** E2EEStatus plus the transient client-side "loading" state. */
export type E2EEUiStatus = E2EEStatus | { state: "loading" };

export function useE2EE(): { status: E2EEUiStatus; refresh: () => void } {
  const [status, setStatus] = useState<E2EEUiStatus>({ state: "loading" });

  const check = useCallback(() => {
    let cancelled = false;
    setStatus({ state: "loading" });
    e2eeService
      .ensureReady()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setStatus({
            state: "unavailable",
            reason: err instanceof Error ? err.message : "E2EE unavailable",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => check(), [check]);

  const refresh = useCallback(() => {
    void check();
  }, [check]);

  return { status, refresh };
}

/** Convenience boolean gate: true only when encryption is fully operational. */
export function useE2EEGate(): { ready: boolean; status: E2EEUiStatus; refresh: () => void } {
  const { status, refresh } = useE2EE();
  return { ready: status.state === "ready", status, refresh };
}

/** True when an API error means the peer has never published E2EE keys. */
export function isNoKeysError(err: unknown): boolean {
  return (
    err instanceof AxiosError &&
    err.response?.status === 404 &&
    (err.response.data as { code?: string } | undefined)?.code === "no_keys"
  );
}
