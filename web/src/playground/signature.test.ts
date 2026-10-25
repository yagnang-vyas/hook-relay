import { describe, expect, it } from 'vitest';
import {
  signPayload,
  toHex,
  utf8,
  hmacSha256,
  verifySignature,
  type SignatureScheme,
} from './signature';

const SECRET = 'demo-only-secret';
const BODY = '{"hello":"world"}';
const NOW = 1_735_689_600;

describe('signature primitives', () => {
  it('matches a known HMAC-SHA256 vector (RFC 4231 test case 2)', async () => {
    const mac = await hmacSha256('Jefe', utf8('what do ya want for nothing?'));
    expect(toHex(mac)).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });

  it('produces the GitHub-style sha256=hex header', async () => {
    const header = await signPayload('sha256=hex', SECRET, BODY);
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe.each(['sha256=hex', 'hex', 'base64', 'timestamped'] as SignatureScheme[])(
  'scheme %s',
  (scheme) => {
    const opts = { toleranceSeconds: 300, nowSeconds: NOW };
    const sign = (body = BODY, secret = SECRET, ts = NOW) =>
      signPayload(scheme, secret, body, { timestampSeconds: ts });

    it('accepts a valid signature', async () => {
      expect(await verifySignature(scheme, await sign(), SECRET, BODY, opts)).toEqual({
        valid: true,
      });
    });

    it('rejects a tampered payload', async () => {
      expect(await verifySignature(scheme, await sign(), SECRET, `${BODY} `, opts)).toEqual({
        valid: false,
        reason: 'signature_mismatch',
      });
    });

    it('rejects the wrong secret', async () => {
      expect(await verifySignature(scheme, await sign(BODY, 'other'), SECRET, BODY, opts)).toEqual({
        valid: false,
        reason: 'signature_mismatch',
      });
    });

    it('rejects a missing header', async () => {
      expect(await verifySignature(scheme, undefined, SECRET, BODY, opts)).toEqual({
        valid: false,
        reason: 'missing_header',
      });
      expect(await verifySignature(scheme, '', SECRET, BODY, opts)).toEqual({
        valid: false,
        reason: 'missing_header',
      });
    });

    it('rejects malformed headers', async () => {
      const good = await sign();
      for (const bad of [
        good.slice(0, -5),
        'garbage',
        `${good}x`.replace(/.$/, 'z'),
        'x'.repeat(3000),
      ]) {
        const r = await verifySignature(scheme, bad, SECRET, BODY, opts);
        expect(r.valid).toBe(false);
      }
      expect(await verifySignature(scheme, 'x'.repeat(3000), SECRET, BODY, opts)).toEqual({
        valid: false,
        reason: 'malformed_header',
      });
    });
  },
);

describe('format specifics', () => {
  it('requires the sha256= prefix', async () => {
    const header = (await signPayload('sha256=hex', SECRET, BODY)).slice('sha256='.length);
    expect(await verifySignature('sha256=hex', header, SECRET, BODY)).toEqual({
      valid: false,
      reason: 'malformed_header',
    });
  });

  it('accepts uppercase hex like the service', async () => {
    const header = (await signPayload('hex', SECRET, BODY)).toUpperCase();
    expect(await verifySignature('hex', header, SECRET, BODY)).toEqual({ valid: true });
  });

  it('rejects non-canonical base64', async () => {
    const good = await signPayload('base64', SECRET, BODY);
    const sloppy = `${good.slice(0, 42)}${good[42] === 'A' ? 'B' : 'A'}=`;
    const r = await verifySignature('base64', sloppy, SECRET, BODY);
    expect(r.valid).toBe(false);
  });
});

describe('timestamped scheme', () => {
  it('rejects a correct but stale signature with its own reason', async () => {
    const stale = await signPayload('timestamped', SECRET, BODY, { timestampSeconds: NOW - 3600 });
    expect(
      await verifySignature('timestamped', stale, SECRET, BODY, {
        toleranceSeconds: 300,
        nowSeconds: NOW,
      }),
    ).toEqual({
      valid: false,
      reason: 'timestamp_out_of_tolerance',
    });
  });

  it('binds the timestamp to the signature', async () => {
    const good = await signPayload('timestamped', SECRET, BODY, { timestampSeconds: NOW });
    const forged = good.replace(`t=${NOW}`, `t=${NOW + 1}`);
    expect(await verifySignature('timestamped', forged, SECRET, BODY, { nowSeconds: NOW })).toEqual(
      { valid: false, reason: 'signature_mismatch' },
    );
  });

  it('accepts any matching v1 entry and ignores unknown keys', async () => {
    const good = await signPayload('timestamped', SECRET, BODY, { timestampSeconds: NOW });
    const v1 = good.split('v1=')[1]!;
    const header = `t=${NOW},v1=${'0'.repeat(64)},v0=ignored,v1=${v1}`;
    expect(await verifySignature('timestamped', header, SECRET, BODY, { nowSeconds: NOW })).toEqual(
      { valid: true },
    );
  });
});

describe('raw bytes', () => {
  it('fails when the same JSON is re-serialised with different whitespace', async () => {
    const pretty = JSON.stringify({ a: 1, b: [1, 2] }, null, 2);
    const header = await signPayload('sha256=hex', SECRET, pretty);
    const minified = JSON.stringify(JSON.parse(pretty));
    expect(await verifySignature('sha256=hex', header, SECRET, minified)).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });
});
