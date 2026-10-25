import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './client';

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
}

/** Runs `load` on mount and whenever `deps` change; cancels the in-flight request on change. */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  enabled = true,
): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState(enabled);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    loadRef
      .current(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setData(value);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          err instanceof ApiError
            ? err
            : new ApiError({ status: 0, code: 'unknown', message: String(err), kind: 'unknown' }),
        );
        setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [...deps, enabled, tick]);

  const reload = useCallback(() => {
    setTick((t) => t + 1);
  }, []);
  return { data, error, loading, reload };
}
