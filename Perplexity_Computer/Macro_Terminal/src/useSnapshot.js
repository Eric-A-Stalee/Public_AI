import { useCallback, useEffect, useRef, useState } from "react";
import { validateSnapshot } from "./model.js";

export const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Refreshes the published snapshot; upstream collection runs separately. */
export function useSnapshot() {
  const [snapshot, setSnapshot] = useState(null);
  const [state, setState] = useState({
    loading: true,
    error: null,
    checkedAt: null,
  });
  const controller = useRef(null);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setState((previous) => ({ ...previous, loading: true, error: null }));
    const timeout = window.setTimeout(() => request.abort("timeout"), 20000);
    try {
      const response = await fetch(
        `${import.meta.env.BASE_URL}data/latest.json`,
        {
          cache: "no-store",
          signal: request.signal,
        },
      );
      if (!response.ok)
        throw new Error(`Snapshot request failed (HTTP ${response.status}).`);
      const next = validateSnapshot(await response.json());
      if (!mounted.current || controller.current !== request) return;
      setSnapshot(next);
      setState({
        loading: false,
        error: null,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (!mounted.current || controller.current !== request) return;
      if (request.signal.aborted && request.signal.reason !== "timeout") return;
      const message =
        request.signal.reason === "timeout"
          ? "Snapshot request timed out. Try checking again."
          : error instanceof Error
            ? error.message
            : "The published snapshot could not be read.";
      // An unsuccessful refresh never replaces the last successfully validated dataset.
      setState((previous) => ({ ...previous, loading: false, error: message }));
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const interval = window.setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      window.clearInterval(interval);
    };
  }, [refresh]);

  return { snapshot, ...state, refresh };
}
