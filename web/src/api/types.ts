// Response shapes of the existing HookRelay admin API (see openapi.yaml). Read-only mirror.

export const DELIVERY_STATUSES = ['pending', 'in_flight', 'retrying', 'delivered', 'dead'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export type DeadReason = 'permanent_status' | 'max_attempts' | 'unknown_target' | 'body_purged';

export interface EventSummary {
  id: string;
  sourceId: string;
  deliveryId: string;
  generatedId: boolean;
  contentType: string | null;
  headers: Record<string, string>;
  bodySize: number;
  bodyPurged: boolean;
  receivedAt: string;
  deliveries: { id: string; targetId: string; status: DeliveryStatus; attempts: number }[];
}

export interface Attempt {
  id: string;
  attemptNumber: number;
  startedAt: string;
  durationMs: number;
  statusCode: number | null;
  error: string | null;
}

export interface Delivery {
  id: string;
  eventId: string;
  targetId: string;
  status: DeliveryStatus;
  attempts: number;
  attemptsBase: number;
  nextAttemptAt: string;
  leaseUntil: string | null;
  lastStatus: number | null;
  lastError: string | null;
  deadReason: DeadReason | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

export interface EventDetail extends Omit<EventSummary, 'deliveries'> {
  /** Present only when requested with `includeBody=true`; null once purged. */
  bodyBase64?: string | null;
  deliveries: (Delivery & { attemptHistory: Attempt[] })[];
}

export interface DeadDelivery {
  id: string;
  eventId: string;
  targetId: string;
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  deadReason: DeadReason | null;
  createdAt: string;
  updatedAt: string;
  event: { sourceId: string; deliveryId: string; bodyPurged: boolean };
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface MetricCounter {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface ReplayResult {
  deliveries: { id: string; targetId: string; status: DeliveryStatus }[];
}

export type Health = { status: 'ok' } | { status: 'ready' };
export interface Readiness {
  ready: boolean;
  status: string;
  reason?: string;
}
