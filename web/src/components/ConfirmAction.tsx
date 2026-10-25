import { useCallback, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { Button, Dialog, ErrorBanner } from './ui';

/**
 * Confirmation dialog for operational actions. The confirm button is disabled while the request
 * is in flight so a double click cannot submit twice, and the server's result is shown verbatim.
 */
export function ConfirmAction<R>({
  title,
  open,
  onClose,
  confirmLabel,
  description,
  run,
  renderResult,
  onDone,
  danger = false,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  confirmLabel: string;
  description: ReactNode;
  run: () => Promise<R>;
  renderResult: (result: R) => ReactNode;
  onDone: () => void;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | undefined>();
  const [result, setResult] = useState<{ value: R } | undefined>();

  const close = useCallback(() => {
    if (busy) return;
    const finished = result !== undefined;
    setError(undefined);
    setResult(undefined);
    onClose();
    if (finished) onDone();
  }, [busy, result, onClose, onDone]);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setResult({ value: await run() });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err
          : new ApiError({ status: 0, code: 'unknown', message: String(err), kind: 'unknown' }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={title}
      open={open}
      onClose={close}
      footer={
        result === undefined ? (
          <>
            <Button onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={danger ? 'danger' : 'primary'}
              busy={busy}
              onClick={() => void submit()}
            >
              {busy ? 'Submitting' : confirmLabel}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={close}>
            Close
          </Button>
        )
      }
    >
      {result === undefined ? description : renderResult(result.value)}
      {error !== undefined && <ErrorBanner error={error} />}
    </Dialog>
  );
}

export const AT_LEAST_ONCE_NOTE =
  'HookRelay delivers at least once. The target may already have processed an earlier attempt, so it can receive this event again and must deduplicate on the X-HookRelay-Event-Id header.';
