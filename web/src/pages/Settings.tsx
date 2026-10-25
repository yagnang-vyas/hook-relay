import { useState } from 'react';
import { ApiError } from '../api/client';
import { useConnection } from '../api/connection';
import { Badge, Button, Card, Field, Input, Notice, PageHeader } from '../components/ui';

export function SettingsPage() {
  const { client, baseUrl, setBaseUrl, hasApiKey, setApiKey, clearApiKey } = useConnection();
  const [url, setUrl] = useState(baseUrl);
  const [key, setKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | undefined>();

  const test = async (): Promise<void> => {
    setTesting(true);
    setResult(undefined);
    try {
      await client.getMetrics();
      setResult({ ok: true, text: 'Connected. The admin API accepted the key.' });
    } catch (err) {
      const e = err instanceof ApiError ? err : undefined;
      setResult({
        ok: false,
        text:
          e !== undefined
            ? `${e.message} (${e.code}${e.requestId !== undefined ? `, request ID ${e.requestId}` : ''})`
            : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Connection"
        description="Where the console finds your HookRelay instance and how it authenticates."
      />
      <div className="max-w-2xl space-y-4">
        <Card title="API base URL">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setBaseUrl(url);
            }}
          >
            <Field
              label="Base URL"
              hint="Leave empty for same-origin (the bundled nginx or the Vite dev proxy). A different origin needs CORS or a reverse proxy; HookRelay does not send CORS headers."
            >
              {(id) => (
                <Input
                  id={id}
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                  }}
                  placeholder="http://127.0.0.1:3000"
                  autoComplete="off"
                />
              )}
            </Field>
            <Button type="submit">Save URL</Button>
          </form>
        </Card>

        <Card
          title="Admin API key"
          actions={
            <Badge tone={hasApiKey ? 'success' : 'neutral'}>
              {hasApiKey ? 'set (memory only)' : 'not set'}
            </Badge>
          }
        >
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim() === '') return;
              setApiKey(key);
              setKey('');
              setResult(undefined);
            }}
          >
            <Field
              label="ADMIN_API_KEY"
              hint="Sent only as a Bearer header to the base URL above. Never written to storage, URLs or logs; gone when you close or reload the tab."
            >
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" disabled={key.trim() === ''}>
                Use key
              </Button>
              <Button onClick={() => void test()} busy={testing} disabled={!hasApiKey}>
                Test connection
              </Button>
              <Button onClick={clearApiKey} disabled={!hasApiKey}>
                Forget key
              </Button>
            </div>
          </form>
          {result !== undefined && (
            <div className="mt-3" role="status">
              <Notice tone={result.ok ? 'info' : 'warn'}>{result.text}</Notice>
            </div>
          )}
        </Card>
        <Notice>
          The Playground never uses this key and sends no network requests. Only the Dashboard pages
          talk to your instance.
        </Notice>
      </div>
    </>
  );
}
