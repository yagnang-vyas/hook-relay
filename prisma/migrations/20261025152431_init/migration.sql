-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('pending', 'in_flight', 'retrying', 'delivered', 'dead');

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL,
    "source_id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "generated_id" BOOLEAN NOT NULL DEFAULT false,
    "headers" JSONB NOT NULL,
    "content_type" TEXT,
    "body" BYTEA,
    "body_size" INTEGER NOT NULL,
    "body_purged" BOOLEAN NOT NULL DEFAULT false,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "target_id" TEXT NOT NULL,
    "status" "delivery_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "attempts_base" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMPTZ(3),
    "last_status" INTEGER,
    "last_error" TEXT,
    "dead_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(3),

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempts" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration_ms" INTEGER NOT NULL,
    "status_code" INTEGER,
    "error" TEXT,

    CONSTRAINT "attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "events_received_at_idx" ON "events"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "events_source_id_delivery_id_key" ON "events"("source_id", "delivery_id");

-- CreateIndex
CREATE INDEX "deliveries_status_next_attempt_at_idx" ON "deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "deliveries_event_id_idx" ON "deliveries"("event_id");

-- CreateIndex
CREATE INDEX "deliveries_status_lease_until_idx" ON "deliveries"("status", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "attempts_delivery_id_attempt_number_key" ON "attempts"("delivery_id", "attempt_number");

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
