import type { SignatureScheme } from './signature';

/** Demo-only secrets. They are public, obviously fake, and unrelated to any real deployment. */
export const DEMO_SECRETS = {
  github: 'demo-only-secret-github-NOT-A-REAL-SECRET',
  payments: 'demo-only-secret-payments-NOT-A-REAL-SECRET',
} as const;

export interface DemoSource {
  id: 'github' | 'payments';
  scheme: SignatureScheme;
  signatureHeader: string;
  deliveryIdHeader: string;
  targets: string[];
  secret: string;
  toleranceSeconds: number;
}

/** Mirrors hookrelay.config.example.json. */
export const DEMO_SOURCES: DemoSource[] = [
  {
    id: 'github',
    scheme: 'sha256=hex',
    signatureHeader: 'X-Hub-Signature-256',
    deliveryIdHeader: 'X-GitHub-Delivery',
    targets: ['orders-service'],
    secret: DEMO_SECRETS.github,
    toleranceSeconds: 0,
  },
  {
    id: 'payments',
    scheme: 'timestamped',
    signatureHeader: 'X-Signature',
    deliveryIdHeader: 'X-Event-Id',
    targets: ['billing-service'],
    secret: DEMO_SECRETS.payments,
    toleranceSeconds: 300,
  },
];

export interface Sample {
  id: string;
  label: string;
  sourceId: DemoSource['id'];
  deliveryId: string;
  payload: unknown;
}

export const SAMPLES: Sample[] = [
  {
    id: 'payment_succeeded',
    label: 'Payment succeeded',
    sourceId: 'payments',
    deliveryId: 'evt_demo_1001',
    payload: {
      type: 'payment.succeeded',
      data: { id: 'pay_demo_42', amount: 4999, currency: 'usd' },
    },
  },
  {
    id: 'order_created',
    label: 'Order created',
    sourceId: 'github',
    deliveryId: 'dlv-demo-2001',
    payload: { action: 'order.created', order: { id: 'ord_demo_7', items: 3, total: 120.5 } },
  },
  {
    id: 'subscription_updated',
    label: 'Subscription updated',
    sourceId: 'payments',
    deliveryId: 'evt_demo_3001',
    payload: {
      type: 'subscription.updated',
      data: { id: 'sub_demo_9', plan: 'pro', status: 'active' },
    },
  },
  {
    id: 'custom',
    label: 'Generic custom webhook',
    sourceId: 'github',
    deliveryId: 'dlv-demo-4001',
    payload: { hello: 'world', note: 'Edit me' },
  },
];

export const pretty = (value: unknown): string => JSON.stringify(value, null, 2);
