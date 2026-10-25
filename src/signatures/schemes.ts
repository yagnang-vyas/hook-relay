import { SHA256_BYTES, hmacSha256, matchesAny } from './hmac.js';

export type FailureReason =
  'missing_header' | 'malformed_header' | 'signature_mismatch' | 'timestamp_out_of_tolerance';

export type VerifyResult = { valid: true } | { valid: false; reason: FailureReason };

const VALID: VerifyResult = { valid: true };
const invalid = (reason: FailureReason): VerifyResult => ({ valid: false, reason });

/** Upper bounds that keep hostile headers from costing more than a constant amount of work. */
const MAX_HEADER_LENGTH = 2048;
const MAX_SIGNATURE_ENTRIES = 16;

const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;
const BASE64_SHA256 = /^[A-Za-z0-9+/]{43}=$/;
const UNIX_SECONDS = /^[0-9]{1,12}$/;

export type HmacFormat = 'sha256=hex' | 'hex' | 'base64';

function decodeSignature(format: HmacFormat, header: string): Buffer | undefined {
  switch (format) {
    case 'sha256=hex': {
      const prefix = 'sha256=';
      if (!header.startsWith(prefix)) return undefined;
      const hex = header.slice(prefix.length);
      return HEX_SHA256.test(hex) ? Buffer.from(hex, 'hex') : undefined;
    }
    case 'hex':
      return HEX_SHA256.test(header) ? Buffer.from(header, 'hex') : undefined;
    case 'base64': {
      if (!BASE64_SHA256.test(header)) return undefined;
      const decoded = Buffer.from(header, 'base64');
      // The regex admits non-canonical trailing bits; require an exact round trip.
      return decoded.length === SHA256_BYTES && decoded.toString('base64') === header
        ? decoded
        : undefined;
    }
  }
}

export function verifyHmac(
  format: HmacFormat,
  header: string | undefined,
  secrets: readonly Buffer[],
  body: Buffer,
): VerifyResult {
  if (header === undefined || header.length === 0) return invalid('missing_header');
  if (header.length > MAX_HEADER_LENGTH) return invalid('malformed_header');
  const provided = decodeSignature(format, header);
  if (provided === undefined) return invalid('malformed_header');
  const expected = secrets.map((secret) => hmacSha256(secret, body));
  return matchesAny(expected, provided) ? VALID : invalid('signature_mismatch');
}

interface ParsedTimestampedHeader {
  timestamp: number;
  signatures: Buffer[];
}

/** Parses `t=<unix>,v1=<hex>[,v1=<hex>...]`; unknown keys are ignored for forward compatibility. */
export function parseTimestampedHeader(header: string): ParsedTimestampedHeader | undefined {
  const parts = header.split(',');
  if (parts.length > MAX_SIGNATURE_ENTRIES) return undefined;
  let timestamp: number | undefined;
  const signatures: Buffer[] = [];
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
      signatures.push(Buffer.from(value, 'hex'));
    }
  }
  if (timestamp === undefined || signatures.length === 0) return undefined;
  return { timestamp, signatures };
}

export function verifyTimestampedHmac(
  header: string | undefined,
  secrets: readonly Buffer[],
  body: Buffer,
  toleranceSeconds: number,
  nowSeconds: number,
): VerifyResult {
  if (header === undefined || header.length === 0) return invalid('missing_header');
  if (header.length > MAX_HEADER_LENGTH) return invalid('malformed_header');
  const parsed = parseTimestampedHeader(header);
  if (parsed === undefined) return invalid('malformed_header');

  const signedPrefix = `${parsed.timestamp}.`;
  const expected = secrets.map((secret) => hmacSha256(secret, signedPrefix, body));
  let matched = false;
  for (const provided of parsed.signatures) {
    if (matchesAny(expected, provided)) matched = true;
  }
  if (!matched) return invalid('signature_mismatch');
  // Only a correctly signed but stale request is reported as a timestamp problem.
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    return invalid('timestamp_out_of_tolerance');
  }
  return VALID;
}
