// Browser re-implementation of HookRelay's signature schemes for demonstration only
// (mirrors src/signatures/schemes.ts). The real verification happens server-side over the raw
// request bytes; nothing here is used by, or can influence, the service.

export type SignatureScheme = 'sha256=hex' | 'hex' | 'base64' | 'timestamped';

export type FailureReason =
  'missing_header' | 'malformed_header' | 'signature_mismatch' | 'timestamp_out_of_tolerance';

export type VerifyResult = { valid: true } | { valid: false; reason: FailureReason };

const MAX_HEADER_LENGTH = 2048;
const MAX_SIGNATURE_ENTRIES = 16;
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;
const BASE64_SHA256 = /^[A-Za-z0-9+/]{43}=$/;
const UNIX_SECONDS = /^[0-9]{1,12}$/;

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

export async function hmacSha256(
  secret: string,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Compares without exiting early on the first differing byte. */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function signedInput(
  scheme: SignatureScheme,
  body: string,
  timestamp?: number,
): Uint8Array<ArrayBuffer> {
  return scheme === 'timestamped' ? utf8(`${timestamp ?? 0}.${body}`) : utf8(body);
}

/** Produces the header value a provider would send for `body`. */
export async function signPayload(
  scheme: SignatureScheme,
  secret: string,
  body: string,
  opts: { timestampSeconds?: number } = {},
): Promise<string> {
  const ts = opts.timestampSeconds ?? 0;
  const mac = await hmacSha256(secret, signedInput(scheme, body, ts));
  switch (scheme) {
    case 'sha256=hex':
      return `sha256=${toHex(mac)}`;
    case 'hex':
      return toHex(mac);
    case 'base64':
      return toBase64(mac);
    case 'timestamped':
      return `t=${ts},v1=${toHex(mac)}`;
  }
}

function decodeSimple(
  scheme: Exclude<SignatureScheme, 'timestamped'>,
  header: string,
): Uint8Array | undefined {
  switch (scheme) {
    case 'sha256=hex': {
      if (!header.startsWith('sha256=')) return undefined;
      const hex = header.slice('sha256='.length);
      return HEX_SHA256.test(hex) ? fromHex(hex) : undefined;
    }
    case 'hex':
      return HEX_SHA256.test(header) ? fromHex(header) : undefined;
    case 'base64': {
      if (!BASE64_SHA256.test(header)) return undefined;
      const decoded = fromBase64(header);
      return decoded.length === 32 && toBase64(decoded) === header ? decoded : undefined;
    }
  }
}

function parseTimestamped(
  header: string,
): { timestamp: number; signatures: Uint8Array[] } | undefined {
  const parts = header.split(',');
  if (parts.length > MAX_SIGNATURE_ENTRIES) return undefined;
  let timestamp: number | undefined;
  const signatures: Uint8Array[] = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) return undefined;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (timestamp !== undefined || !UNIX_SECONDS.test(value)) return undefined;
      timestamp = Number(value);
    } else if (key === 'v1') {
      if (!HEX_SHA256.test(value)) return undefined;
      signatures.push(fromHex(value));
    }
  }
  if (timestamp === undefined || signatures.length === 0) return undefined;
  return { timestamp, signatures };
}

export async function verifySignature(
  scheme: SignatureScheme,
  header: string | undefined,
  secret: string,
  body: string,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): Promise<VerifyResult> {
  if (header === undefined || header.length === 0)
    return { valid: false, reason: 'missing_header' };
  if (header.length > MAX_HEADER_LENGTH) return { valid: false, reason: 'malformed_header' };

  if (scheme === 'timestamped') {
    const parsed = parseTimestamped(header);
    if (parsed === undefined) return { valid: false, reason: 'malformed_header' };
    const expected = await hmacSha256(secret, signedInput(scheme, body, parsed.timestamp));
    const matched = parsed.signatures.some((s) => timingSafeEqualBytes(s, expected));
    if (!matched) return { valid: false, reason: 'signature_mismatch' };
    const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - parsed.timestamp) > (opts.toleranceSeconds ?? 300)) {
      return { valid: false, reason: 'timestamp_out_of_tolerance' };
    }
    return { valid: true };
  }

  const provided = decodeSimple(scheme, header);
  if (provided === undefined) return { valid: false, reason: 'malformed_header' };
  const expected = await hmacSha256(secret, signedInput(scheme, body));
  return timingSafeEqualBytes(provided, expected)
    ? { valid: true }
    : { valid: false, reason: 'signature_mismatch' };
}

export const REASON_EXPLANATIONS: Record<FailureReason, string> = {
  missing_header: 'The signature header was absent or empty.',
  malformed_header:
    'The header does not match the scheme format (wrong prefix, not 64 hex characters, bad base64, or an unparsable t=/v1= list).',
  signature_mismatch:
    'The header is well formed, but the HMAC of the received bytes differs: wrong secret, or the body changed after signing.',
  timestamp_out_of_tolerance:
    'The signature is correct but its timestamp is outside the tolerance window, which blocks replay of old requests.',
};
