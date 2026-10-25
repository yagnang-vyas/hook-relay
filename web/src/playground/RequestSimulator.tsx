import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, CodeBlock, Field, Input, Select, Textarea } from '../components/ui';
import { simulateIngest, type SimResponse } from './ingestSim';
import type { Registry } from './registry';
import { DEMO_SOURCES, SAMPLES, pretty, type DemoSource } from './samples';
import { signPayload } from './signature';
import { CopyButton, SimBanner } from './ui';

type SigMode = 'valid' | 'tampered' | 'stale' | 'missing' | 'malformed' | 'manual';

export function validateJson(text: string): string | undefined {
  if (text.trim() === '') return 'Payload is empty.';
  try {
    JSON.parse(text);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid JSON';
  }
}

function headersToText(h: Record<string, string>): string {
  return Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

export function parseHeaders(text: string): { headers: Record<string, string>; error?: string } {
  const headers: Record<string, string> = {};
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    const idx = line.indexOf(':');
    if (idx <= 0) return { headers, error: `Line ${i + 1} is not "Name: value".` };
    headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { headers };
}

const SENSITIVE = /^(authorization|cookie|proxy-authorization|x-api-key)$/i;

export function RequestSimulator({
  registry,
  onRegistry,
  clockMs,
  onAdvance,
}: {
  registry: Registry;
  onRegistry: (r: Registry) => void;
  clockMs: number;
  onAdvance: () => void;
}) {
  const first = SAMPLES[0]!;
  const [sampleId, setSampleId] = useState(first.id);
  const [sourceId, setSourceId] = useState<DemoSource['id']>(first.sourceId);
  const [payload, setPayload] = useState(pretty(first.payload));
  const [headerText, setHeaderText] = useState('');
  const [sigMode, setSigMode] = useState<SigMode>('valid');
  const [manualSig, setManualSig] = useState('');
  const [signature, setSignature] = useState<string | undefined>();
  const [response, setResponse] = useState<SimResponse | undefined>();
  const [running, setRunning] = useState(false);

  const source = DEMO_SOURCES.find((s) => s.id === sourceId) as DemoSource;
  const jsonError = validateJson(payload);
  const parsedHeaders = parseHeaders(headerText);
  const sensitive = Object.keys(parsedHeaders.headers).find((k) => SENSITIVE.test(k));
  const nowSeconds = Math.floor(clockMs / 1000);

  const sentBody = sigMode === 'tampered' ? `${payload} ` : payload;

  const loadSample = (id: string): void => {
    const s = SAMPLES.find((x) => x.id === id) ?? first;
    const src = DEMO_SOURCES.find((x) => x.id === s.sourceId) as DemoSource;
    setSampleId(s.id);
    setSourceId(s.sourceId);
    setPayload(pretty(s.payload));
    setHeaderText(
      headersToText({ 'Content-Type': 'application/json', [src.deliveryIdHeader]: s.deliveryId }),
    );
    setSigMode('valid');
    setResponse(undefined);
  };

  useEffect(() => {
    loadSample(first.id);
  }, []);

  // The signature header is recomputed whenever anything it depends on changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let value: string | undefined;
      if (sigMode === 'missing') value = undefined;
      else if (sigMode === 'manual') value = manualSig;
      else if (sigMode === 'malformed')
        value = source.scheme === 'timestamped' ? 't=abc,v1=zz' : 'sha256=not-a-valid-signature';
      else {
        const ts = sigMode === 'stale' ? nowSeconds - 3600 : nowSeconds;
        value = await signPayload(source.scheme, source.secret, payload, { timestampSeconds: ts });
      }
      if (!cancelled) setSignature(value);
    })();
    return () => {
      cancelled = true;
    };
  }, [sigMode, manualSig, payload, source, nowSeconds]);

  const requestHeaders = useMemo(() => {
    const h = { ...parsedHeaders.headers };
    if (signature !== undefined && signature !== '') h[source.signatureHeader] = signature;
    return h;
  }, [headerText, signature, source]);

  const preview = `POST /hooks/${sourceId} HTTP/1.1\n${headersToText(requestHeaders)}\n\n${sentBody}`;
  const canRun =
    jsonError === undefined &&
    parsedHeaders.error === undefined &&
    sensitive === undefined &&
    !running;

  const run = async (): Promise<void> => {
    if (!canRun) return;
    setRunning(true);
    try {
      const res = await simulateIngest(
        { sourceId, headers: requestHeaders, body: sentBody },
        registry,
        clockMs,
      );
      setResponse(res);
      onRegistry(res.registry);
      onAdvance();
    } finally {
      setRunning(false);
    }
  };

  const reset = (): void => {
    loadSample(first.id);
    setManualSig('');
  };

  return (
    <div className="space-y-4">
      <SimBanner>
        Simulated ingest endpoint. This builds a request and runs it against a local model of POST
        /hooks/&#123;sourceId&#125;; it is never sent anywhere.
      </SimBanner>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Request builder">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Example">
                {(id) => (
                  <Select
                    id={id}
                    value={sampleId}
                    onChange={(e) => {
                      loadSample(e.target.value);
                    }}
                  >
                    {SAMPLES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Demo source" hint={`${source.scheme} in ${source.signatureHeader}`}>
                {(id) => (
                  <Select
                    id={id}
                    value={sourceId}
                    onChange={(e) => {
                      setSourceId(e.target.value as DemoSource['id']);
                      setResponse(undefined);
                    }}
                  >
                    {DEMO_SOURCES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.id}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <div className="font-mono text-xs text-muted">POST /hooks/{sourceId}</div>
            <Field label="JSON payload">
              {(id) => (
                <Textarea
                  id={id}
                  rows={9}
                  value={payload}
                  onChange={(e) => {
                    setPayload(e.target.value);
                  }}
                  aria-invalid={jsonError !== undefined}
                  aria-describedby="payload-error"
                  spellCheck={false}
                />
              )}
            </Field>
            <div
              id="payload-error"
              role={jsonError !== undefined ? 'alert' : undefined}
              className="text-xs"
            >
              {jsonError !== undefined ? (
                <span className="text-danger">
                  Invalid JSON: {jsonError}. The request cannot be run until this is fixed.
                </span>
              ) : (
                <span className="text-success">Valid JSON</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={jsonError !== undefined}
                onClick={() => {
                  setPayload(JSON.stringify(JSON.parse(payload), null, 2));
                }}
              >
                Format JSON
              </Button>
              <CopyButton text={payload} label="Copy payload" />
            </div>
            <Field
              label="Headers (non-sensitive, one per line)"
              hint="Do not enter real credentials. Authorization and cookie headers are rejected."
            >
              {(id) => (
                <Textarea
                  id={id}
                  rows={3}
                  value={headerText}
                  onChange={(e) => {
                    setHeaderText(e.target.value);
                  }}
                  spellCheck={false}
                />
              )}
            </Field>
            {parsedHeaders.error !== undefined && (
              <p role="alert" className="text-xs text-danger">
                {parsedHeaders.error}
              </p>
            )}
            {sensitive !== undefined && (
              <p role="alert" className="text-xs text-danger">
                Header "{sensitive}" looks like a credential and is not allowed in the playground.
              </p>
            )}
            <Field
              label="Signature (demo secret)"
              hint="Computed in your browser with Web Crypto using a public, fake demo secret."
            >
              {(id) => (
                <Select
                  id={id}
                  value={sigMode}
                  onChange={(e) => {
                    setSigMode(e.target.value as SigMode);
                  }}
                >
                  <option value="valid">Valid signature</option>
                  <option value="tampered">Valid signature, body altered after signing</option>
                  {source.scheme === 'timestamped' && (
                    <option value="stale">Valid but stale timestamp (1 hour old)</option>
                  )}
                  <option value="malformed">Malformed signature</option>
                  <option value="missing">Missing signature header</option>
                  <option value="manual">Enter signature manually</option>
                </Select>
              )}
            </Field>
            {sigMode === 'manual' && (
              <Field label="Signature header value">
                {(id) => (
                  <Input
                    id={id}
                    value={manualSig}
                    onChange={(e) => {
                      setManualSig(e.target.value);
                    }}
                    className="font-mono"
                  />
                )}
              </Field>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                busy={running}
                disabled={!canRun}
                onClick={() => void run()}
              >
                Run simulated request
              </Button>
              <Button onClick={reset}>Reset inputs</Button>
            </div>
          </div>
        </Card>

        <div className="space-y-4">
          <Card title="Request preview" actions={<Badge tone="sim">not sent</Badge>}>
            <CodeBlock label="Request preview">{preview}</CodeBlock>
          </Card>
          <Card title="Simulated response">
            {response === undefined ? (
              <p className="text-sm text-muted">Run the request to see the simulated response.</p>
            ) : (
              <div className="space-y-2" aria-live="polite">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="sim">SIMULATED</Badge>
                  <Badge tone={response.status < 300 ? 'success' : 'danger'}>
                    HTTP {response.status}
                  </Badge>
                  <span className="font-mono text-xs text-muted">
                    X-Request-Id: {response.requestId}
                  </span>
                </div>
                <CodeBlock label="Simulated response body">{pretty(response.body)}</CodeBlock>
                {response.serverNote !== undefined && (
                  <p className="text-xs text-muted">
                    Server-side only (never returned to the caller): {response.serverNote}
                  </p>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
