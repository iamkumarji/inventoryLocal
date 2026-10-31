import { useCallback, useEffect, useState } from "react";

import { messageOf } from "@/api/client";

type LoadState<T> = { data: T | undefined; error: string | null; loading: boolean };

/** Minimal data loader: loading, error message, reload. Results of superseded loads are ignored. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<LoadState<T>>({ data: undefined, error: null, loading: true });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (e: unknown) => live && setState((s) => ({ ...s, error: messageOf(e), loading: false })),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    setNonce((n) => n + 1);
  }, []);

  return { ...state, reload };
}
