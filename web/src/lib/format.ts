export function formatTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(m < 10 ? 1 : 0)} min`;
  return `${(m / 60).toFixed(1)} h`;
}

export type DecodedBody =
  | { kind: 'json'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'binary'; text: string };

/** Decodes a stored payload for display as text. Never interpreted as HTML. */
export function decodeBody(base64: string): DecodedBody {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const hex = Array.from(bytes.slice(0, 512), (b) => b.toString(16).padStart(2, '0')).join(' ');
    return {
      kind: 'binary',
      text: `Binary payload (${bytes.length} bytes). First ${Math.min(bytes.length, 512)} bytes in hex:\n${hex}`,
    };
  }
  try {
    return { kind: 'json', text: JSON.stringify(JSON.parse(text), null, 2) };
  } catch {
    return { kind: 'text', text };
  }
}
