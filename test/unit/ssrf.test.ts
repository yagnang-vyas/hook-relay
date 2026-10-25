import { describe, expect, it } from 'vitest';
import {
  SsrfError,
  assertSafeTarget,
  classifyAddress,
  createGuardedLookup,
  defaultResolver,
  normalizeHostname,
  parseIPv4,
  parseIPv6,
  type SsrfPolicy,
} from '../../src/delivery/ssrf.js';

const strict: SsrfPolicy = { allowPrivateTargets: new Set(), allowHttp: false };

describe('classifyAddress: IPv4', () => {
  it.each([
    ['0.0.0.0', 'unspecified'],
    ['0.255.255.255', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['100.127.255.255', 'carrier-grade NAT'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link-local'],
    ['169.254.0.1', 'link-local'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.0.1', 'private'],
    ['192.168.255.255', 'private'],
    ['192.0.0.1', 'IETF'],
    ['192.0.2.7', 'documentation'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['198.51.100.1', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
  ])('blocks %s', (address, label) => {
    expect(classifyAddress(address)).toContain(label);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '100.63.255.255',
    '100.128.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '169.253.255.255',
    '169.255.0.0',
    '192.167.255.255',
    '192.169.0.0',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255',
    '11.0.0.0',
    '9.255.255.255',
    '126.255.255.255',
    '128.0.0.0',
  ])('allows public address %s', (address) => {
    expect(classifyAddress(address)).toBeUndefined();
  });
});

describe('classifyAddress: IPv6', () => {
  it.each([
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456:789a::1', 'unique-local'],
    ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['fe80::1%eth0', 'link-local'],
    ['fec0::1', 'site-local'],
    ['ff02::1', 'multicast'],
    ['ff00::', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2001::1', 'Teredo'],
    ['100::1', 'discard'],
    ['::1.2.3.4', 'IPv4-compatible'],
    ['::0.0.0.2', 'IPv4-compatible'],
    ['64:ff9b:1::1', 'local-use NAT64'],
  ])('blocks %s', (address, label) => {
    expect(classifyAddress(address)).toContain(label);
  });

  it.each([
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback'],
    ['::ffff:10.1.2.3', 'IPv4-mapped private'],
    ['::ffff:169.254.169.254', 'IPv4-mapped link-local'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped link-local'],
    ['0:0:0:0:0:ffff:192.168.1.1', 'IPv4-mapped private'],
    ['64:ff9b::127.0.0.1', 'NAT64 loopback'],
    ['64:ff9b::a00:1', 'NAT64 private'],
    ['2002:7f00:1::', '6to4 loopback'],
    ['2002:a9fe:a9fe::1', '6to4 link-local'],
    ['2002:c0a8:101::1', '6to4 private'],
  ])('blocks the embedded IPv4 in %s', (address, label) => {
    expect(classifyAddress(address)).toContain(label.split(' ').slice(1).join(' ') || label);
  });

  it.each([
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '2a00:1450:4001:81b::200e',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '64:ff9b::8.8.8.8',
    '2002:808:808::1',
    '2001:1::1',
    '2000::1',
  ])('allows public address %s', (address) => {
    expect(classifyAddress(address)).toBeUndefined();
  });
});

describe('classifyAddress: invalid input fails closed', () => {
  it.each([
    '',
    'example.com',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '01.2.3.4',
    'abcd',
    ':::',
    '1:2:3:4:5:6:7:8:9',
    'gggg::1',
    '::1::2',
    '[::1]',
  ])('treats %j as unparseable', (value) => {
    expect(classifyAddress(value)).toBe('unparseable address');
  });
});

describe('parsers', () => {
  it('parseIPv4 rejects leading zeros and out-of-range octets', () => {
    expect(parseIPv4('1.2.3.4')).toBe(16909060);
    expect(parseIPv4('1.2.3.04')).toBeUndefined();
    expect(parseIPv4('1.2.3.256')).toBeUndefined();
    expect(parseIPv4('1.2.3')).toBeUndefined();
    expect(parseIPv4('a.b.c.d')).toBeUndefined();
  });

  it('parseIPv6 handles compression, embedded IPv4 and zones', () => {
    expect(parseIPv6('::')).toBe(0n);
    expect(parseIPv6('::1')).toBe(1n);
    expect(parseIPv6('1::')).toBe(1n << 112n);
    expect(parseIPv6('::ffff:1.2.3.4')).toBe(0xffff01020304n);
    expect(parseIPv6('fe80::1%en0')).toBe(parseIPv6('fe80::1'));
    expect(parseIPv6('1:2:3:4:5:6:7:8')).toBe(0x00010002000300040005000600070008n);
    expect(parseIPv6('1:2:3:4:5:6:7::')).toBe(0x00010002000300040005000600070000n);
  });

  it('parseIPv6 rejects malformed literals', () => {
    for (const bad of [
      '',
      '%eth0',
      '1::2::3',
      '1:2:3:4:5:6:7:8:9',
      '1:2:3:4:5:6:7',
      '::1.2.3',
      ':1:2:3:4:5:6:7',
      '12345::',
      'g::',
      '1:2:3:4:5:6:7:8::',
    ]) {
      expect(parseIPv6(bad), bad).toBeUndefined();
    }
  });
});

describe('normalizeHostname', () => {
  it.each([
    ['http://Example.COM/x', 'example.com'],
    ['http://example.com./x', 'example.com'],
    ['http://[::1]:8080/x', '::1'],
    ['http://127.0.0.1/x', '127.0.0.1'],
    ['http://2130706433/x', '127.0.0.1'],
    ['http://0x7f.1/x', '127.0.0.1'],
    ['http://017700000001/x', '127.0.0.1'],
  ])('%s -> %s', (url, expected) => {
    expect(normalizeHostname(new URL(url))).toBe(expected);
  });
});

describe('assertSafeTarget', () => {
  const resolverFor = (map: Record<string, string[]>) => (host: string) => {
    const found = map[host];
    return found === undefined ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve(found);
  };

  it('allows a hostname that resolves only to public addresses', async () => {
    await expect(
      assertSafeTarget(
        new URL('https://hooks.example.com/x'),
        strict,
        resolverFor({ 'hooks.example.com': ['93.184.216.34', '2606:2800:220:1::1'] }),
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects when any resolved address is private (mixed answers)', async () => {
    await expect(
      assertSafeTarget(
        new URL('https://rebind.example.com/'),
        strict,
        resolverFor({ 'rebind.example.com': ['93.184.216.34', '10.0.0.5'] }),
      ),
    ).rejects.toThrow(/private/);
  });

  it('rejects hostnames that resolve to loopback, metadata and IPv4-mapped addresses', async () => {
    const resolver = resolverFor({
      'a.test': ['127.0.0.1'],
      'b.test': ['169.254.169.254'],
      'c.test': ['::ffff:127.0.0.1'],
      'd.test': ['fd00::1'],
      'e.test': ['0.0.0.0'],
    });
    for (const host of ['a.test', 'b.test', 'c.test', 'd.test', 'e.test']) {
      await expect(
        assertSafeTarget(new URL(`https://${host}/`), strict, resolver),
        host,
      ).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it('rejects IP literals without consulting DNS', async () => {
    const neverCalled = () => Promise.reject(new Error('resolver must not be called'));
    for (const url of [
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.1/',
      'https://[::ffff:10.0.0.1]/',
      'https://2130706433/',
      'https://[fe80::1]/',
    ]) {
      await expect(assertSafeTarget(new URL(url), strict, neverCalled), url).rejects.toThrow(
        /address/,
      );
    }
  });

  it('accepts public IP literals', async () => {
    await expect(assertSafeTarget(new URL('https://8.8.8.8/'), strict)).resolves.toBeUndefined();
    await expect(
      assertSafeTarget(new URL('https://[2606:4700:4700::1111]/'), strict),
    ).resolves.toBeUndefined();
  });

  it('rejects names that do not resolve', async () => {
    await expect(
      assertSafeTarget(new URL('https://nx.example.com/'), strict, resolverFor({})),
    ).rejects.toThrow(/did not resolve/);
    await expect(
      assertSafeTarget(
        new URL('https://empty.example.com/'),
        strict,
        resolverFor({ 'empty.example.com': [] }),
      ),
    ).rejects.toThrow(/did not resolve/);
  });

  it('honours the private-target allow list, case-insensitively', async () => {
    const policy: SsrfPolicy = {
      allowPrivateTargets: new Set(['orders', '127.0.0.1']),
      allowHttp: true,
    };
    const resolver = resolverFor({ orders: ['10.1.2.3'] });
    await expect(
      assertSafeTarget(new URL('http://ORDERS:8080/hook'), policy, resolver),
    ).resolves.toBeUndefined();
    await expect(assertSafeTarget(new URL('http://127.0.0.1:9/'), policy)).resolves.toBeUndefined();
    // Not on the list: still blocked.
    await expect(
      assertSafeTarget(
        new URL('http://billing:8080/'),
        policy,
        resolverFor({ billing: ['10.1.2.4'] }),
      ),
    ).rejects.toThrow(/private/);
  });

  it('enforces the scheme policy', async () => {
    const resolver = resolverFor({ 'hooks.example.com': ['93.184.216.34'] });
    await expect(
      assertSafeTarget(new URL('http://hooks.example.com/'), strict, resolver),
    ).rejects.toThrow(/scheme/);
    await expect(
      assertSafeTarget(
        new URL('http://hooks.example.com/'),
        { ...strict, allowHttp: true },
        resolver,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeTarget(
        new URL('ftp://hooks.example.com/'),
        { ...strict, allowHttp: true },
        resolver,
      ),
    ).rejects.toThrow(/scheme/);
    await expect(assertSafeTarget(new URL('file:///etc/passwd'), strict, resolver)).rejects.toThrow(
      /scheme/,
    );
  });

  it('resolves real localhost through the default resolver and blocks it', async () => {
    await expect(assertSafeTarget(new URL('https://localhost/'), strict)).rejects.toBeInstanceOf(
      SsrfError,
    );
    await expect(defaultResolver('does-not-exist.invalid')).rejects.toThrow();
    expect(await defaultResolver('localhost')).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(127\.0\.0\.1|::1)$/)]),
    );
  });
});

describe('createGuardedLookup', () => {
  type Result = { err: Error | null; address: unknown; family?: number };
  const run = (
    lookup: ReturnType<typeof createGuardedLookup>,
    host: string,
    options: { all?: boolean } | undefined,
  ) =>
    new Promise<Result>((resolve) => {
      lookup(host, options, (err, address, family) => {
        resolve({ err, address, ...(family !== undefined ? { family } : {}) });
      });
    });
  const resolverFor = (addresses: { address: string; family: number }[]) => () =>
    Promise.resolve(addresses);

  it('returns the first address for single lookups and all of them when asked', async () => {
    const lookup = createGuardedLookup(
      strict,
      resolverFor([
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800::1', family: 6 },
      ]),
    );
    expect(await run(lookup, 'x.example.com', undefined)).toEqual({
      err: null,
      address: '93.184.216.34',
      family: 4,
    });
    const all = await run(lookup, 'x.example.com', { all: true });
    expect(all.address).toHaveLength(2);
  });

  it('rejects a connect-time answer that points inside the network (DNS rebinding)', async () => {
    const lookup = createGuardedLookup(strict, resolverFor([{ address: '127.0.0.1', family: 4 }]));
    const result = await run(lookup, 'rebind.example.com', { all: true });
    expect(result.err).toBeInstanceOf(SsrfError);
  });

  it('lets allow-listed hosts through to private addresses', async () => {
    const policy: SsrfPolicy = { allowPrivateTargets: new Set(['orders']), allowHttp: true };
    const lookup = createGuardedLookup(policy, resolverFor([{ address: '10.0.0.9', family: 4 }]));
    expect((await run(lookup, 'Orders', undefined)).err).toBeNull();
  });

  it('fails closed on empty answers and propagates resolver errors', async () => {
    const empty = createGuardedLookup(strict, resolverFor([]));
    expect((await run(empty, 'x.example.com', undefined)).err).toBeInstanceOf(SsrfError);
    const failing = createGuardedLookup(strict, () => Promise.reject(new Error('ENOTFOUND')));
    expect((await run(failing, 'x.example.com', undefined)).err?.message).toBe('ENOTFOUND');
  });

  it('uses real DNS by default', async () => {
    const lookup = createGuardedLookup(strict);
    expect((await run(lookup, 'localhost', undefined)).err).toBeInstanceOf(SsrfError);
    const allowed = createGuardedLookup({
      allowPrivateTargets: new Set(['localhost']),
      allowHttp: true,
    });
    expect((await run(allowed, 'localhost', undefined)).err).toBeNull();
    expect((await run(lookup, 'does-not-exist.invalid', undefined)).err).not.toBeNull();
  });
});
