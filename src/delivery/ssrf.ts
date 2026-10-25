import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export interface SsrfPolicy {
  /** Lower-cased hostnames that may point at private addresses. */
  allowPrivateTargets: ReadonlySet<string>;
  allowHttp: boolean;
}

type Cidr4 = readonly [base: string, prefix: number, label: string];

const BLOCKED_V4: readonly Cidr4[] = [
  ['0.0.0.0', 8, 'unspecified/this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved/broadcast'],
];

export function parseIPv4(text: string): number | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

const BLOCKED_V4_PARSED = BLOCKED_V4.map(([base, prefix, label]) => {
  const parsed = parseIPv4(base) as number;
  const size = 2 ** (32 - prefix);
  return { start: parsed, end: parsed + size - 1, label };
});

function classifyV4(value: number): string | undefined {
  for (const range of BLOCKED_V4_PARSED) {
    if (value >= range.start && value <= range.end) return range.label;
  }
  return undefined;
}

/** Parses an IPv6 literal (with optional zone and embedded IPv4) into a 128-bit integer. */
export function parseIPv6(input: string): bigint | undefined {
  let text = input;
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text.length === 0) return undefined;

  // Convert a trailing dotted-quad into two hextets.
  const lastColon = text.lastIndexOf(':');
  if (lastColon !== -1 && text.includes('.', lastColon)) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    const hi = Math.floor(v4 / 65536).toString(16);
    const lo = (v4 % 65536).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const parse = (s: string): string[] | undefined => {
    if (s === '') return [];
    const groups = s.split(':');
    return groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g)) ? groups : undefined;
  };
  const gap = text.indexOf('::');
  if (gap !== text.lastIndexOf('::') || text.includes(':::')) return undefined;
  const head = parse(gap === -1 ? text : text.slice(0, gap));
  const tail = gap === -1 ? [] : parse(text.slice(gap + 2));
  if (head === undefined || tail === undefined) return undefined;

  let groups: string[];
  if (gap !== -1) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return undefined;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return undefined;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

function inV6(value: bigint, base: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return value >> shift === base >> shift;
}

const V6 = (text: string): bigint => parseIPv6(text) as bigint;
const V6_UNSPECIFIED = 0n;
const V6_LOOPBACK = 1n;
const V6_MAPPED = V6('::ffff:0:0');
const V6_NAT64 = V6('64:ff9b::');
const V6_NAT64_LOCAL = V6('64:ff9b:1::');
const V6_COMPAT = V6('::');
const V6_DISCARD = V6('100::');
const V6_TEREDO = V6('2001::');
const V6_DOC = V6('2001:db8::');
const V6_6TO4 = V6('2002::');
const V6_ULA = V6('fc00::');
const V6_LINK_LOCAL = V6('fe80::');
const V6_SITE_LOCAL = V6('fec0::');
const V6_MULTICAST = V6('ff00::');

const low32 = (value: bigint): number => Number(value & 0xffffffffn);

function classifyV6(value: bigint): string | undefined {
  if (value === V6_UNSPECIFIED) return 'unspecified';
  if (value === V6_LOOPBACK) return 'loopback';
  // Wrappers that embed an IPv4 address are judged by the address they embed.
  if (inV6(value, V6_MAPPED, 96)) {
    const inner = classifyV4(low32(value));
    return inner !== undefined ? `IPv4-mapped ${inner}` : undefined;
  }
  if (inV6(value, V6_NAT64, 96)) {
    const inner = classifyV4(low32(value));
    return inner !== undefined ? `NAT64 ${inner}` : undefined;
  }
  if (inV6(value, V6_6TO4, 16)) {
    const inner = classifyV4(Number((value >> 80n) & 0xffffffffn));
    return inner !== undefined ? `6to4 ${inner}` : undefined;
  }
  if (inV6(value, V6_NAT64_LOCAL, 48)) return 'local-use NAT64';
  if (inV6(value, V6_COMPAT, 96)) return 'IPv4-compatible';
  if (inV6(value, V6_DISCARD, 64)) return 'discard-only';
  if (inV6(value, V6_TEREDO, 32)) return 'Teredo';
  if (inV6(value, V6_DOC, 32)) return 'documentation';
  if (inV6(value, V6_ULA, 7)) return 'unique-local';
  if (inV6(value, V6_LINK_LOCAL, 10)) return 'link-local';
  if (inV6(value, V6_SITE_LOCAL, 10)) return 'site-local';
  if (inV6(value, V6_MULTICAST, 8)) return 'multicast';
  return undefined;
}

/**
 * Returns why an IP literal must not be contacted (for example `"private"`), or `undefined` if
 * it is a public address. Anything that is not a valid IP literal is reported as unparseable so
 * that callers fail closed.
 */
export function classifyAddress(address: string): string | undefined {
  const v4 = parseIPv4(address);
  if (v4 !== undefined) return classifyV4(v4);
  const v6 = parseIPv6(address);
  if (v6 !== undefined) return classifyV6(v6);
  return 'unparseable address';
}

/** Lower-cased hostname without IPv6 brackets or a trailing root dot. */
export function normalizeHostname(url: URL): string {
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

export type Resolver = (hostname: string) => Promise<string[]>;

export const defaultResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err !== null) reject(err);
      else resolve(addresses.map((a) => a.address));
    });
  });

function checkScheme(url: URL, policy: SsrfPolicy): void {
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && policy.allowHttp) return;
  throw new SsrfError(`scheme ${url.protocol} is not allowed`);
}

/**
 * Resolves the target host and rejects it if any resolved address is loopback, private,
 * link-local, carrier-grade NAT, unique-local, unspecified, multicast or otherwise reserved,
 * unless the hostname is explicitly allow-listed.
 */
export async function assertSafeTarget(
  url: URL,
  policy: SsrfPolicy,
  resolve: Resolver = defaultResolver,
): Promise<void> {
  checkScheme(url, policy);
  const host = normalizeHostname(url);
  if (policy.allowPrivateTargets.has(host)) return;

  const addresses = isIP(host) !== 0 ? [host] : await resolve(host).catch(() => []);
  if (addresses.length === 0) throw new SsrfError('hostname did not resolve');
  for (const address of addresses) {
    const reason = classifyAddress(address);
    if (reason !== undefined) throw new SsrfError(`target resolves to a ${reason} address`);
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` function for the HTTP client's connector. The pre-flight check alone would leave a
 * window for DNS rebinding; validating again at connect time means the address that is actually
 * dialled is the address that was checked.
 */
export function createGuardedLookup(
  policy: SsrfPolicy,
  resolve: (hostname: string) => Promise<LookupAddress[]> = (hostname) =>
    new Promise((res, rej) => {
      dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
        if (err !== null) rej(err);
        else res(addrs);
      });
    }),
) {
  return (
    hostname: string,
    options: { all?: boolean } | undefined,
    callback: LookupCallback,
  ): void => {
    const host = hostname.toLowerCase();
    resolve(host).then(
      (addresses) => {
        if (!policy.allowPrivateTargets.has(host)) {
          for (const { address } of addresses) {
            const reason = classifyAddress(address);
            if (reason !== undefined) {
              callback(new SsrfError(`target resolves to a ${reason} address`), '', 0);
              return;
            }
          }
        }
        const first = addresses[0];
        if (first === undefined) {
          callback(new SsrfError('hostname did not resolve'), '', 0);
        } else if (options?.all === true) {
          callback(null, addresses);
        } else {
          callback(null, first.address, first.family);
        }
      },
      (err: unknown) => {
        callback(err as NodeJS.ErrnoException, '', 0);
      },
    );
  };
}
