import { createHmac } from 'node:crypto';

/** Test-side signing helpers, written independently of the code under test. */
export function hmacHex(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function githubSignature(secret: string, body: string | Buffer): string {
  return `sha256=${hmacHex(secret, body)}`;
}

export function base64Signature(secret: string, body: string | Buffer): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

export function timestampedSignature(
  secret: string | string[],
  body: string | Buffer,
  timestamp: number,
): string {
  const secrets = Array.isArray(secret) ? secret : [secret];
  const bodyBuf = typeof body === 'string' ? Buffer.from(body) : body;
  const sigs = secrets.map((s) =>
    hmacHex(s, Buffer.concat([Buffer.from(`${timestamp}.`), bodyBuf])),
  );
  return `t=${timestamp},${sigs.map((s) => `v1=${s}`).join(',')}`;
}
