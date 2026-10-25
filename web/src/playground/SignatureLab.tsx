import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  Field,
  Input,
  Notice,
  Select,
  Textarea,
} from '../components/ui';
import { DEMO_SECRETS, pretty } from './samples';
import {
  REASON_EXPLANATIONS,
  signPayload,
  verifySignature,
  type SignatureScheme,
  type VerifyResult,
} from './signature';
import { CopyButton, SimBanner } from './ui';
import { validateJson } from './RequestSimulator';

const FIXED_NOW_SECONDS = 1_735_689_600; // 2025-01-01T00:00:00Z, so results are reproducible

interface Row {
  id: string;
  title: string;
  explanation: string;
  header: string | undefined;
  body: string;
  expectValid: boolean;
  result: VerifyResult;
}

const DEFAULT_PAYLOAD = pretty({
  type: 'payment.succeeded',
  data: { id: 'pay_demo_42', amount: 4999 },
});

export function SignatureLab() {
  const [payload, setPayload] = useState(DEFAULT_PAYLOAD);
  const [scheme, setScheme] = useState<SignatureScheme>('sha256=hex');
  const [secret, setSecret] = useState<string>(DEMO_SECRETS.github);
  const [rows, setRows] = useState<Row[]>([]);
  const [custom, setCustom] = useState('');
  const [customResult, setCustomResult] = useState<VerifyResult | undefined>();
  const [validHeader, setValidHeader] = useState('');

  const jsonError = validateJson(payload);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ts = FIXED_NOW_SECONDS;
      const opts = { toleranceSeconds: 300, nowSeconds: FIXED_NOW_SECONDS };
      const good = await signPayload(scheme, secret, payload, { timestampSeconds: ts });
      const wrongSecret = await signPayload(scheme, `${secret}-wrong`, payload, {
        timestampSeconds: ts,
      });
      const stale = await signPayload(scheme, secret, payload, { timestampSeconds: ts - 3600 });
      let reformatted = payload;
      try {
        reformatted = JSON.stringify(JSON.parse(payload));
      } catch {
        // Invalid JSON: the reformatting example is skipped below.
      }
      const defs: Omit<Row, 'result'>[] = [
        {
          id: 'valid',
          title: 'Valid signature',
          explanation: 'Signed with the shared secret over exactly these bytes.',
          header: good,
          body: payload,
          expectValid: true,
        },
        {
          id: 'tampered',
          title: 'Payload tampered after signing',
          explanation: 'One character appended. Any change to the bytes changes the HMAC.',
          header: good,
          body: `${payload} `,
          expectValid: false,
        },
        {
          id: 'wrong_secret',
          title: 'Wrong secret',
          explanation: 'A sender that does not know the secret cannot produce a matching MAC.',
          header: wrongSecret,
          body: payload,
          expectValid: false,
        },
        {
          id: 'malformed',
          title: 'Malformed signature',
          explanation: 'Truncated header: rejected before any HMAC comparison.',
          header: good.slice(0, Math.max(3, good.length - 10)),
          body: payload,
          expectValid: false,
        },
        {
          id: 'missing',
          title: 'Missing signature header',
          explanation: 'No header at all.',
          header: undefined,
          body: payload,
          expectValid: false,
        },
        ...(reformatted !== payload && jsonError === undefined
          ? [
              {
                id: 'reformatted',
                title: 'Same JSON, re-serialised',
                explanation:
                  'Semantically identical JSON with different whitespace. Signatures cover bytes, not meaning, so verifying after a parse and re-serialise would fail. This is why HookRelay verifies the raw body before any JSON parsing.',
                header: good,
                body: reformatted,
                expectValid: false,
              },
            ]
          : []),
        ...(scheme === 'timestamped'
          ? [
              {
                id: 'stale',
                title: 'Correct signature, stale timestamp',
                explanation:
                  'Signed one hour ago; the tolerance is 300 s, so it is rejected to stop replay.',
                header: stale,
                body: payload,
                expectValid: false,
              },
            ]
          : []),
      ];
      const out: Row[] = [];
      for (const d of defs) {
        out.push({ ...d, result: await verifySignature(scheme, d.header, secret, d.body, opts) });
      }
      if (!cancelled) {
        setRows(out);
        setValidHeader(good);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [payload, scheme, secret, jsonError]);

  const verifyCustom = async (): Promise<void> => {
    setCustomResult(
      await verifySignature(scheme, custom, secret, payload, {
        toleranceSeconds: 300,
        nowSeconds: FIXED_NOW_SECONDS,
      }),
    );
  };

  return (
    <div className="space-y-4">
      <SimBanner>
        Browser demonstration with Web Crypto and demo-only secrets. Real verification runs on the
        server over the raw request bytes.
      </SimBanner>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Inputs">
          <div className="space-y-3">
            <Field label="Scheme">
              {(id) => (
                <Select
                  id={id}
                  value={scheme}
                  onChange={(e) => {
                    const next = e.target.value as SignatureScheme;
                    setScheme(next);
                    setSecret(next === 'timestamped' ? DEMO_SECRETS.payments : DEMO_SECRETS.github);
                  }}
                >
                  <option value="sha256=hex">hmac-sha256, sha256=hex (GitHub style)</option>
                  <option value="hex">hmac-sha256, hex</option>
                  <option value="base64">hmac-sha256, base64</option>
                  <option value="timestamped">timestamped-hmac-sha256 (t=…,v1=…)</option>
                </Select>
              )}
            </Field>
            <Field
              label="Demo-only secret"
              hint="Fake and public. Never paste a real signing secret into this page."
            >
              {(id) => (
                <Input
                  id={id}
                  value={secret}
                  onChange={(e) => {
                    setSecret(e.target.value);
                  }}
                  className="font-mono"
                  autoComplete="off"
                />
              )}
            </Field>
            <Field label="Payload (raw request body)">
              {(id) => (
                <Textarea
                  id={id}
                  rows={8}
                  value={payload}
                  onChange={(e) => {
                    setPayload(e.target.value);
                  }}
                  spellCheck={false}
                />
              )}
            </Field>
            {jsonError !== undefined && (
              <p role="alert" className="text-xs text-warn">
                Not valid JSON ({jsonError}). HMAC works on any bytes, so the lab still runs;
                HookRelay only requires JSON if your target does.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  setPayload(DEFAULT_PAYLOAD);
                }}
              >
                Reset payload
              </Button>
              <Button
                disabled={jsonError !== undefined}
                onClick={() => {
                  setPayload(JSON.stringify(JSON.parse(payload)));
                }}
              >
                Minify (changes the bytes)
              </Button>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-muted">Generated signature header</span>
                <CopyButton text={validHeader} />
              </div>
              <CodeBlock label="Generated signature">{validHeader}</CodeBlock>
            </div>
          </div>
        </Card>

        <Card title="Verification examples">
          <ul className="space-y-3" aria-label="Verification examples">
            {rows.map((r) => {
              const matches = r.result.valid === r.expectValid;
              return (
                <li key={r.id} className="rounded-md border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{r.title}</span>
                    <Badge tone={r.result.valid ? 'success' : 'danger'}>
                      {r.result.valid ? 'accepted' : `rejected: ${r.result.reason}`}
                    </Badge>
                    {!matches && <Badge tone="warn">unexpected</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted">{r.explanation}</p>
                  {!r.result.valid && (
                    <p className="mt-1 text-xs text-muted">
                      {REASON_EXPLANATIONS[r.result.reason]}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card title="Try your own header">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <Field label="Signature header value to verify against the payload above">
              {(id) => (
                <Input
                  id={id}
                  value={custom}
                  onChange={(e) => {
                    setCustom(e.target.value);
                    setCustomResult(undefined);
                  }}
                  className="font-mono"
                />
              )}
            </Field>
          </div>
          <Button variant="primary" onClick={() => void verifyCustom()}>
            Verify
          </Button>
        </div>
        {customResult !== undefined && (
          <div className="mt-3" role="status">
            {customResult.valid ? (
              <Badge tone="success">accepted</Badge>
            ) : (
              <>
                <Badge tone="danger">rejected: {customResult.reason}</Badge>
                <p className="mt-1 text-xs text-muted">
                  {REASON_EXPLANATIONS[customResult.reason]}
                </p>
              </>
            )}
          </div>
        )}
      </Card>

      <Notice>
        <strong>Why raw bytes matter.</strong> The sender computes the HMAC over the exact bytes it
        transmits. If a server parses the JSON first and re-serialises it, key order, whitespace and
        number formatting can change and a legitimate request fails verification, while a lenient
        comparison would let tampering through. HookRelay reads the body as raw bytes, verifies, and
        only then stores it. It also compares in constant time and answers every failure with the
        same generic 401, logging the reason only. A browser demo cannot prove any of that; it only
        shows the arithmetic.
      </Notice>
    </div>
  );
}
