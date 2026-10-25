import clsx from 'clsx';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import type { ApiError } from '../api/client';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  variant = 'secondary',
  busy = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'border-accent bg-accent text-accentfg hover:opacity-90',
        variant === 'secondary' && 'border-line bg-panel text-fg hover:bg-panel2',
        variant === 'danger' && 'border-danger bg-danger text-accentfg hover:opacity-90',
        variant === 'ghost' &&
          'border-transparent bg-transparent text-muted hover:bg-panel2 hover:text-fg',
        className,
      )}
    >
      {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx('rounded-lg border border-line bg-panel', className)}>
      {(title !== undefined || actions !== undefined) && (
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

type Tone = 'neutral' | 'success' | 'warn' | 'danger' | 'info' | 'sim';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-xs',
        tone === 'neutral' && 'border-line bg-panel2 text-muted',
        tone === 'success' && 'border-transparent bg-successbg text-success',
        tone === 'warn' && 'border-transparent bg-warnbg text-warn',
        tone === 'danger' && 'border-transparent bg-dangerbg text-danger',
        tone === 'info' && 'border-transparent bg-infobg text-info',
        tone === 'sim' && 'border-transparent bg-simbg text-sim',
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

export function statusTone(status: string): Tone {
  switch (status) {
    case 'delivered':
      return 'success';
    case 'dead':
      return 'danger';
    case 'retrying':
      return 'warn';
    case 'in_flight':
    case 'pending':
      return 'info';
    default:
      return 'neutral';
  }
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{status}</Badge>;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx('break-all font-mono text-xs', className)}>{children}</span>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}…
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children !== undefined && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function ErrorBanner({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const hint =
    error.kind === 'unauthorized'
      ? 'The admin API key is missing or wrong. Update it in Settings.'
      : error.kind === 'rate_limited'
        ? 'Too many requests. Wait a moment and try again.'
        : error.kind === 'forbidden'
          ? 'This credential is not allowed to perform the request.'
          : undefined;
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger/40 bg-dangerbg p-3 text-sm text-danger"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {error.message}
            {error.status > 0 && (
              <span className="ml-2 font-mono text-xs">HTTP {error.status}</span>
            )}
          </p>
          {hint !== undefined && <p className="mt-0.5">{hint}</p>}
          <p className="mt-1 font-mono text-xs">
            code: {error.code}
            {error.requestId !== undefined && <> · request ID: {error.requestId}</>}
          </p>
        </div>
        {onRetry !== undefined && (
          <Button onClick={onRetry} className="shrink-0">
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'sim';
  children: ReactNode;
}) {
  return (
    <div
      className={clsx(
        'rounded-lg border px-3 py-2 text-sm',
        tone === 'info' && 'border-info/30 bg-infobg text-info',
        tone === 'warn' && 'border-warn/30 bg-warnbg text-warn',
        tone === 'sim' && 'border-sim/30 bg-simbg text-sim',
      )}
    >
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-muted">
        {label}
      </label>
      {children(id)}
      {hint !== undefined && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

const inputClass =
  'w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm text-fg placeholder:text-muted';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(inputClass, props.className)} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx(inputClass, props.className)} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx(inputClass, 'font-mono text-xs', props.className)} />;
}

export function CodeBlock({ children, label }: { children: string; label?: string }) {
  return (
    <pre
      aria-label={label}
      className="max-h-96 overflow-auto rounded-md border border-line bg-panel2 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all"
    >
      {children}
    </pre>
  );
}

/** Modal dialog with Escape-to-close and focus moved into the dialog on open. */
export function Dialog({
  title,
  open,
  onClose,
  children,
  footer,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-lg rounded-lg border border-line bg-panel shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 id={titleId} className="font-semibold">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            className="text-muted hover:text-fg"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <div className="space-y-3 p-4 text-sm">{children}</div>
        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold">{title}</h1>
        {description !== undefined && (
          <p className="mt-0.5 max-w-3xl text-sm text-muted">{description}</p>
        )}
      </div>
      {actions}
    </div>
  );
}

export function SimBadge() {
  return <Badge tone="sim">SIMULATED</Badge>;
}
