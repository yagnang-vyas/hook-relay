import clsx from 'clsx';
import { Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge, Button, SimBadge } from '../components/ui';
import { formatVirtualTime, type SimDelivery, type TimelineStep } from './engine';

export function SimBanner({ children }: { children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sim/30 bg-simbg px-3 py-2 text-sm text-sim">
      <SimBadge />
      <span>
        {children ??
          'Everything below runs locally in your browser. No request leaves this page and no HookRelay data is read or written.'}
      </span>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => {
              setDone(false);
            }, 1500);
          })
          .catch(() => {
            // Clipboard can be blocked; the text remains selectable on the page.
          });
      }}
    >
      <Copy className="size-3.5" aria-hidden /> {done ? 'Copied' : label}
    </Button>
  );
}

const toneClass: Record<TimelineStep['tone'], string> = {
  neutral: 'bg-muted',
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
};

export function Timeline({
  steps,
  label = 'Simulated timeline',
}: {
  steps: TimelineStep[];
  label?: string;
}) {
  if (steps.length === 0) return <p className="text-sm text-muted">No steps yet.</p>;
  return (
    <ol aria-label={label} className="space-y-0">
      {steps.map((s, i) => (
        <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
          <span className="relative flex w-3 shrink-0 justify-center">
            <span className="absolute top-3 bottom-[-1rem] w-px bg-line last:hidden" aria-hidden />
            <span className={clsx('mt-1.5 size-2.5 rounded-full', toneClass[s.tone])} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium">{s.title}</span>
              <span className="font-mono text-xs text-muted" title="Virtual, illustrative time">
                {formatVirtualTime(s.atMs)}
              </span>
            </div>
            <p className="text-xs text-muted">{s.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function DeliveryTable({ deliveries }: { deliveries: SimDelivery[] }) {
  return (
    <div className="space-y-3">
      {deliveries.map((d) => (
        <div key={d.id} className="rounded-md border border-line">
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel2 px-3 py-1.5 text-xs">
            <Badge
              tone={
                d.status === 'delivered'
                  ? 'success'
                  : d.status === 'dead'
                    ? 'danger'
                    : d.status === 'retrying'
                      ? 'warn'
                      : 'info'
              }
            >
              {d.status}
            </Badge>
            <span className="font-mono">{d.id}</span>
            <span className="text-muted">→ {d.targetId}</span>
            <span className="ml-auto font-mono text-muted">
              attempts {d.attempts} (budget {d.attempts - d.attemptsBase})
              {d.deadReason !== null && ` · ${d.deadReason}`}
            </span>
          </div>
          {d.attemptHistory.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted">No attempts yet.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="text-muted">
                <tr>
                  <th className="px-3 py-1 font-medium">#</th>
                  <th className="px-3 py-1 font-medium">Started</th>
                  <th className="px-3 py-1 font-medium">HTTP</th>
                  <th className="px-3 py-1 font-medium">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line font-mono">
                {d.attemptHistory.map((a) => (
                  <tr key={a.attemptNumber}>
                    <td className="px-3 py-1">{a.attemptNumber}</td>
                    <td className="px-3 py-1">{formatVirtualTime(a.startedAtMs)}</td>
                    <td className="px-3 py-1">{a.statusCode ?? '—'}</td>
                    <td className="px-3 py-1">{a.error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}
