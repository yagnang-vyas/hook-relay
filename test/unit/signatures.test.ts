import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SchemeConfig } from '../../src/config.js';
import { constantTimeEqual, hmacSha256, matchesAny } from '../../src/signatures/hmac.js';
import { verifySignature } from '../../src/signatures/index.js';
import { parseTimestampedHeader } from '../../src/signatures/schemes.js';
import {
  base64Signature,
  githubSignature,
  hmacHex,
  timestampedSignature,
} from '../fixtures/sign.js';

const secret = 'whsec_test_primary';
const body = readFileSync(new URL('../fixtures/payloads/github-push.json', import.meta.url));
const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;

const github: SchemeConfig = {
  type: 'hmac-sha256',
  header: 'X-Hub-Signature-256',
  format: 'sha256=hex',
};
const hex: SchemeConfig = { type: 'hmac-sha256', header: 'X-Sig', format: 'hex' };
const b64: SchemeConfig = { type: 'hmac-sha256', header: 'X-Sig', format: 'base64' };
const stripe: SchemeConfig = {
  type: 'timestamped-hmac-sha256',
  header: 'X-Signature',
  toleranceSeconds: 300,
};

function verify(
  scheme: SchemeConfig,
  headerValue: string | undefined,
  secrets = [secret],
  payload = body,
) {
  return verifySignature({
    scheme,
    secrets: secrets.map((s) => Buffer.from(s)),
    headerValue,
    body: payload,
    nowMs: NOW_MS,
  });
}

describe('hmac primitives', () => {
  it('matches the published GitHub documentation vector', () => {
    const mac = hmacSha256(Buffer.from("It's a Secret to Everybody"), 'Hello, World!');
    expect(mac.toString('hex')).toBe(
      '757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
    );
  });

  it('constantTimeEqual handles equal, different and different-length inputs', () => {
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false);
    expect(constantTimeEqual(Buffer.alloc(0), Buffer.alloc(0))).toBe(true);
  });

  it('matchesAny reports a match anywhere in the list and false for none', () => {
    const list = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')];
    expect(matchesAny(list, Buffer.from('c'))).toBe(true);
    expect(matchesAny(list, Buffer.from('a'))).toBe(true);
    expect(matchesAny(list, Buffer.from('d'))).toBe(false);
    expect(matchesAny([], Buffer.from('a'))).toBe(false);
  });
});

describe('hmac-sha256 / sha256=hex', () => {
  it('accepts a valid signature', () => {
    expect(verify(github, githubSignature(secret, body))).toEqual({ valid: true });
  });

  it('accepts upper-case hex', () => {
    const sig = `sha256=${hmacHex(secret, body).toUpperCase()}`;
    expect(verify(github, sig)).toEqual({ valid: true });
  });

  it('rejects a wrong secret', () => {
    expect(verify(github, githubSignature('other-secret', body))).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.concat([body, Buffer.from(' ')]);
    expect(verify(github, githubSignature(secret, body), [secret], tampered)).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects re-serialised JSON because the raw bytes differ', () => {
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8'))));
    expect(reserialised.equals(body)).toBe(false);
    expect(verify(github, githubSignature(secret, body), [secret], reserialised).valid).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])('reports a %s header as missing', (_name, value) => {
    expect(verify(github, value)).toEqual({ valid: false, reason: 'missing_header' });
  });

  it.each([
    ['no prefix', hmacHex(secret, body)],
    ['wrong prefix', `sha1=${hmacHex(secret, body)}`],
    ['prefix only', 'sha256='],
    ['short digest', 'sha256=abcd'],
    ['long digest', `sha256=${hmacHex(secret, body)}00`],
    ['non-hex characters', `sha256=${'z'.repeat(64)}`],
    ['whitespace padding', ` sha256=${hmacHex(secret, body)}`],
    ['oversized header', `sha256=${'a'.repeat(5000)}`],
  ])('reports %s as malformed without throwing', (_name, value) => {
    expect(verify(github, value)).toEqual({ valid: false, reason: 'malformed_header' });
  });
});

describe('hmac-sha256 / hex', () => {
  it('accepts a valid signature and rejects the prefixed form', () => {
    expect(verify(hex, hmacHex(secret, body))).toEqual({ valid: true });
    expect(verify(hex, githubSignature(secret, body)).valid).toBe(false);
  });

  it('rejects a wrong secret', () => {
    expect(verify(hex, hmacHex('nope', body))).toMatchObject({ reason: 'signature_mismatch' });
  });
});

describe('hmac-sha256 / base64', () => {
  it('accepts a valid signature', () => {
    expect(verify(b64, base64Signature(secret, body))).toEqual({ valid: true });
  });

  it('rejects a wrong secret and a tampered body', () => {
    expect(verify(b64, base64Signature('nope', body))).toMatchObject({
      reason: 'signature_mismatch',
    });
    expect(verify(b64, base64Signature(secret, body), [secret], Buffer.from('{}'))).toMatchObject({
      reason: 'signature_mismatch',
    });
  });

  it.each([
    ['hex instead of base64', hmacHex(secret, body)],
    ['wrong length', 'c2hvcnQ='],
    ['invalid alphabet', `${'!'.repeat(43)}=`],
    [
      'url-safe alphabet',
      base64Signature(secret, body).replace(/\+/g, '-').replace(/\//g, '_') + 'x',
    ],
    ['missing padding', base64Signature(secret, body).slice(0, -1)],
  ])('treats %s as malformed', (_name, value) => {
    expect(verify(b64, value)).toMatchObject({ valid: false, reason: 'malformed_header' });
  });

  it('rejects base64 with non-canonical trailing bits', () => {
    // Flip a trailing bit of the last character: decodes to the same bytes but is not canonical.
    const good = base64Signature(secret, body);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const last = good.charAt(42);
    const idx = alphabet.indexOf(last);
    const sibling = alphabet.charAt(idx ^ 1);
    const mutated = `${good.slice(0, 42)}${sibling}=`;
    expect(Buffer.from(mutated, 'base64').equals(Buffer.from(good, 'base64'))).toBe(true);
    expect(verify(b64, mutated)).toEqual({ valid: false, reason: 'malformed_header' });
  });
});

describe('secret rotation', () => {
  it('accepts a signature made with any configured secret', () => {
    const secrets = ['new-secret', 'old-secret'];
    expect(verify(github, githubSignature('old-secret', body), secrets)).toEqual({ valid: true });
    expect(verify(github, githubSignature('new-secret', body), secrets)).toEqual({ valid: true });
    expect(verify(github, githubSignature('retired', body), secrets).valid).toBe(false);
  });

  it('rejects everything when no secrets are configured', () => {
    expect(verify(github, githubSignature(secret, body), []).valid).toBe(false);
  });
});

describe('timestamped-hmac-sha256', () => {
  it('accepts a valid, fresh signature', () => {
    expect(verify(stripe, timestampedSignature(secret, body, NOW_S))).toEqual({ valid: true });
  });

  it('accepts timestamps at the edge of the tolerance, past and future', () => {
    expect(verify(stripe, timestampedSignature(secret, body, NOW_S - 300))).toEqual({
      valid: true,
    });
    expect(verify(stripe, timestampedSignature(secret, body, NOW_S + 300))).toEqual({
      valid: true,
    });
  });

  it('rejects an expired timestamp even though the signature is correct', () => {
    expect(verify(stripe, timestampedSignature(secret, body, NOW_S - 301))).toEqual({
      valid: false,
      reason: 'timestamp_out_of_tolerance',
    });
  });

  it('rejects a timestamp too far in the future', () => {
    expect(verify(stripe, timestampedSignature(secret, body, NOW_S + 301))).toEqual({
      valid: false,
      reason: 'timestamp_out_of_tolerance',
    });
  });

  it('rejects a signature that was made for a different timestamp', () => {
    const sig = timestampedSignature(secret, body, NOW_S - 10);
    const forged = sig.replace(`t=${NOW_S - 10}`, `t=${NOW_S}`);
    expect(verify(stripe, forged)).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('rejects a wrong secret and a tampered body', () => {
    expect(verify(stripe, timestampedSignature('nope', body, NOW_S))).toMatchObject({
      reason: 'signature_mismatch',
    });
    expect(
      verify(stripe, timestampedSignature(secret, body, NOW_S), [secret], Buffer.from('{}')),
    ).toMatchObject({ reason: 'signature_mismatch' });
  });

  it('supports several v1 values and several secrets during rotation', () => {
    const header = timestampedSignature(['retiring-secret', 'next-secret'], body, NOW_S);
    expect(verify(stripe, header, ['next-secret'])).toEqual({ valid: true });
    expect(verify(stripe, header, ['retiring-secret'])).toEqual({ valid: true });
    expect(verify(stripe, header, ['unrelated'])).toMatchObject({ reason: 'signature_mismatch' });
    // Receiver rotated to a new secret while the sender still signs with the old one only.
    const oldOnly = timestampedSignature('retiring-secret', body, NOW_S);
    expect(verify(stripe, oldOnly, ['next-secret', 'retiring-secret'])).toEqual({ valid: true });
  });

  it('ignores unknown keys such as other signature versions', () => {
    const good = timestampedSignature(secret, body, NOW_S);
    expect(verify(stripe, `${good},v0=${'0'.repeat(64)}`)).toEqual({ valid: true });
  });

  it('tolerates whitespace around parts', () => {
    const good = timestampedSignature(secret, body, NOW_S).split(',').join(', ');
    expect(verify(stripe, good)).toEqual({ valid: true });
  });

  it('treats a missing header as missing', () => {
    expect(verify(stripe, undefined)).toEqual({ valid: false, reason: 'missing_header' });
    expect(verify(stripe, '')).toEqual({ valid: false, reason: 'missing_header' });
  });

  const sig = hmacHex(secret, `${NOW_S}.`);
  it.each([
    ['no timestamp', `v1=${sig}`],
    ['no signature', `t=${NOW_S}`],
    ['duplicate timestamp', `t=${NOW_S},t=${NOW_S},v1=${sig}`],
    ['non-numeric timestamp', `t=abc,v1=${sig}`],
    ['negative timestamp', `t=-5,v1=${sig}`],
    ['fractional timestamp', `t=1.5,v1=${sig}`],
    ['absurdly long timestamp', `t=${'9'.repeat(30)},v1=${sig}`],
    ['signature not hex', `t=${NOW_S},v1=${'g'.repeat(64)}`],
    ['signature wrong length', `t=${NOW_S},v1=abcd`],
    ['part without equals sign', `t=${NOW_S},v1`],
    ['part with empty key', `t=${NOW_S},=abc,v1=${sig}`],
    ['garbage', 'not a signature header'],
    ['too many parts', Array.from({ length: 40 }, (_, i) => `k${i}=v`).join(',')],
    ['oversized header', `t=${NOW_S},v1=${'a'.repeat(5000)}`],
  ])('reports %s as malformed without throwing', (_name, value) => {
    expect(verify(stripe, value)).toEqual({ valid: false, reason: 'malformed_header' });
  });

  it('honours a custom tolerance', () => {
    const tight: SchemeConfig = { ...stripe, toleranceSeconds: 5 };
    expect(verify(tight, timestampedSignature(secret, body, NOW_S - 5))).toEqual({ valid: true });
    expect(verify(tight, timestampedSignature(secret, body, NOW_S - 6))).toMatchObject({
      reason: 'timestamp_out_of_tolerance',
    });
  });

  it('signs "<t>.<raw body>" over bytes, including non-UTF-8 payloads', () => {
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x7f]);
    expect(verify(stripe, timestampedSignature(secret, binary, NOW_S), [secret], binary)).toEqual({
      valid: true,
    });
  });
});

describe('parseTimestampedHeader', () => {
  it('returns every v1 signature and the timestamp', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const parsed = parseTimestampedHeader(`t=123,v1=${a},v1=${b}`);
    expect(parsed?.timestamp).toBe(123);
    expect(parsed?.signatures.map((s) => s.toString('hex'))).toEqual([a, b]);
  });

  it('returns undefined for malformed headers', () => {
    expect(parseTimestampedHeader('')).toBeUndefined();
  });
});

describe('empty and large bodies', () => {
  it('verifies an empty body', () => {
    const empty = Buffer.alloc(0);
    expect(verify(github, githubSignature(secret, empty), [secret], empty)).toEqual({
      valid: true,
    });
  });

  it('verifies a 1 MiB body', () => {
    const big = Buffer.alloc(1_048_576, 0x61);
    expect(verify(github, githubSignature(secret, big), [secret], big)).toEqual({ valid: true });
  });
});
