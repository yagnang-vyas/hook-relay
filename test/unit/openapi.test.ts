import { readFileSync } from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';
import type { Express } from 'express';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Metrics } from '../../src/metrics.js';
import type { Db } from '../../src/prisma.js';
import { captureLogger, testConfig } from '../helpers.js';

const specPath = new URL('../../openapi.yaml', import.meta.url).pathname;
const spec = parse(readFileSync(specPath, 'utf8')) as {
  openapi: string;
  paths: Record<
    string,
    Record<string, { operationId?: string; security?: unknown; responses?: object }>
  >;
};

interface RouterLayer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: RouterLayer[] };
}

/** Every `METHOD /path` registered on the Express app, with `:param` rewritten to `{param}`. */
function registeredRoutes(app: Express): string[] {
  const found = new Set<string>();
  const walk = (stack: RouterLayer[]): void => {
    for (const layer of stack) {
      if (layer.route !== undefined) {
        const path = layer.route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
        for (const method of Object.keys(layer.route.methods)) {
          found.add(`${method.toUpperCase()} ${path}`);
        }
      } else if (layer.handle?.stack !== undefined) {
        walk(layer.handle.stack);
      }
    }
  };
  walk((app as unknown as { router: { stack: RouterLayer[] } }).router.stack);
  return [...found].sort();
}

function documentedOperations(): string[] {
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
  const ops: string[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of methods) {
      if (item[method] !== undefined) ops.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return ops.sort();
}

describe('openapi.yaml', () => {
  const app = createApp({
    config: testConfig(),
    logger: captureLogger().logger,
    metrics: new Metrics(),
    readiness: () => Promise.resolve({ ok: true }),
    db: {} as Db,
  });

  it('is a valid OpenAPI 3.1 document', async () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
    await expect(SwaggerParser.validate(specPath)).resolves.toBeDefined();
  });

  it('documents every route the application registers', () => {
    const registered = registeredRoutes(app);
    expect(registered.length).toBeGreaterThanOrEqual(9);
    const documented = documentedOperations();
    const missing = registered.filter((r) => !documented.includes(r));
    expect(missing, `routes missing from openapi.yaml: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not document routes that do not exist', () => {
    const registered = registeredRoutes(app);
    const phantom = documentedOperations().filter((op) => !registered.includes(op));
    expect(phantom, `documented but not implemented: ${phantom.join(', ')}`).toEqual([]);
  });

  it('gives every operation an ID, an explicit security declaration, and responses', () => {
    const ids = new Set<string>();
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        const label = `${method.toUpperCase()} ${path}`;
        expect(op.operationId, label).toBeTruthy();
        expect(ids.has(op.operationId as string), `duplicate operationId ${op.operationId}`).toBe(
          false,
        );
        ids.add(op.operationId as string);
        expect(op.security, `${label} must declare security explicitly`).toBeDefined();
        expect(Object.keys(op.responses ?? {}).length, label).toBeGreaterThan(0);
      }
    }
  });

  it('requires admin authentication on every /api operation and none elsewhere', () => {
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const op of Object.values(item)) {
        const protectedOp = JSON.stringify(op.security) === JSON.stringify([{ bearerAuth: [] }]);
        expect(protectedOp, path).toBe(path.startsWith('/api/'));
      }
    }
  });
});
