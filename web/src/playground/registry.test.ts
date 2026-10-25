import { describe, expect, it } from 'vitest';
import { emptyRegistry, ingestEvent, replayEvent } from './registry';
import { simulateIngest } from './ingestSim';
import { DEMO_SOURCES, DEMO_SECRETS, SAMPLES, pretty } from './samples';
import { signPayload } from './signature';

const base = { sourceId: 'github', payload: '{}', headers: {}, targets: ['orders-service'] };

describe('duplicate detection registry', () => {
  it('accepts the first delivery ID and acknowledges the repeat without storing again', () => {
    const first = ingestEvent(emptyRegistry(), { ...base, deliveryId: 'abc' }, 0);
    if (!first.ok) throw new Error('unexpected');
    expect(first.outcome).toMatchObject({ status: 'accepted', generatedId: false });
    const second = ingestEvent(first.registry, { ...base, deliveryId: 'abc' }, 1);
    if (!second.ok) throw new Error('unexpected');
    expect(second.outcome.status).toBe('duplicate');
    expect(second.registry.events).toHaveLength(1);
  });

  it('treats a different delivery ID, or the same ID under another source, as new events', () => {
    let r = emptyRegistry();
    for (const [src, id] of [
      ['github', 'a'],
      ['github', 'b'],
      ['payments', 'a'],
    ] as const) {
      const out = ingestEvent(r, { ...base, sourceId: src, deliveryId: id }, 0);
      if (!out.ok || out.outcome.status !== 'accepted') throw new Error('unexpected');
      r = out.registry;
    }
    expect(r.events).toHaveLength(3);
  });

  it('generates IDs when none is given and stores every such request', () => {
    let r = emptyRegistry();
    for (let i = 0; i < 2; i++) {
      const out = ingestEvent(r, { ...base, deliveryId: undefined }, 0);
      if (!out.ok) throw new Error('unexpected');
      expect(out.outcome).toMatchObject({ status: 'accepted', generatedId: true });
      r = out.registry;
    }
    expect(r.events).toHaveLength(2);
    expect(r.events[0]!.deliveryId).toMatch(/^gen_/);
  });

  it('rejects unacceptable delivery IDs', () => {
    expect(ingestEvent(emptyRegistry(), { ...base, deliveryId: 'has space' }, 0)).toEqual({
      ok: false,
      error: 'Delivery ID header is not acceptable',
    });
  });
});

describe('simulated replay', () => {
  it('adds new pending deliveries and keeps existing ones', () => {
    const out = ingestEvent(emptyRegistry(), { ...base, deliveryId: 'x' }, 0);
    if (!out.ok || out.outcome.status !== 'accepted') throw new Error('unexpected');
    const replayed = replayEvent(out.registry, out.outcome.eventId, 5)!;
    expect(replayed.event.deliveries).toHaveLength(2);
    expect(replayed.event.deliveries[0]).toEqual(out.registry.events[0]!.deliveries[0]);
    expect(replayed.event.deliveries[1]!.status).toBe('pending');
    expect(replayEvent(out.registry, 'nope', 0)).toBeUndefined();
  });
});

describe('simulated ingest endpoint', () => {
  const sample = SAMPLES.find((s) => s.id === 'order_created')!;
  const body = pretty(sample.payload);
  const source = DEMO_SOURCES.find((s) => s.id === 'github')!;
  const req = async (
    over: { header?: string | undefined; body?: string; id?: string; sourceId?: string } = {},
  ) => ({
    sourceId: over.sourceId ?? 'github',
    headers: {
      [source.deliveryIdHeader]: over.id ?? 'dlv-1',
      ...(over.header !== undefined ? { [source.signatureHeader]: over.header } : {}),
    },
    body: over.body ?? body,
  });
  const valid = () => signPayload(source.scheme, DEMO_SECRETS.github, body);

  it('answers 202, then 200 duplicate', async () => {
    const a = await simulateIngest(await req({ header: await valid() }), emptyRegistry(), 0);
    expect(a).toMatchObject({ status: 202, body: { status: 'accepted' } });
    const b = await simulateIngest(await req({ header: await valid() }), a.registry, 0);
    expect(b).toMatchObject({ status: 200, body: { status: 'duplicate' } });
    expect(b.registry.events).toHaveLength(1);
  });

  it('answers a generic 401 for bad signatures and keeps the reason server-side', async () => {
    const r = await simulateIngest(
      await req({ header: await valid(), body: `${body} ` }),
      emptyRegistry(),
      0,
    );
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: { code: 'invalid_signature', message: 'Unauthorized' } });
    expect(JSON.stringify(r.body)).not.toContain('mismatch');
    expect(r.serverNote).toContain('signature_mismatch');
    expect(r.registry.events).toHaveLength(0);
  });

  it('answers 401 for a missing header, 404 for unknown sources, 400 for bad IDs', async () => {
    expect((await simulateIngest(await req(), emptyRegistry(), 0)).status).toBe(401);
    expect((await simulateIngest(await req({ sourceId: 'nope' }), emptyRegistry(), 0)).status).toBe(
      404,
    );
    expect(
      (await simulateIngest(await req({ header: await valid(), id: 'bad id' }), emptyRegistry(), 0))
        .status,
    ).toBe(400);
  });

  it('answers 413 for oversized bodies', async () => {
    const big = 'x'.repeat(1_048_577);
    expect((await simulateIngest(await req({ body: big }), emptyRegistry(), 0)).status).toBe(413);
  });
});
