import client from "@prometheus-io/client";
import type Redis from "ioredis";
import { collectQueueMetrics } from "./queues";
import type { WorkerQueueSet } from "./queues";
import { collectOutboxMetrics } from "./persist/outbox";
import type { OutboxMetricsSnapshot } from "./persist/outbox";
import { state as breakerState } from "./breaker";
import { redisMemorySnapshot } from "./health";

// ---------------------------------------------------------------------------
// OBS-05 / D-26: the Prometheus exposition registry for the worker's existing
// loopback health server. Every gauge wraps the EXISTING collectors at scrape
// time via collect() — zero new collection logic, zero background intervals,
// zero new connections (deps are the boot-owned queue set + Redis client,
// §25 budget; the 05-05 scraper and gate 2 consume these family names).
//
// Degradation contract (never-fail-the-surface): each collect() clears its
// gauge FIRST and sets nothing when its collector fails — a broken collector
// yields ABSENT samples (missing families to a scraper), never a 500 and
// never STALE values from a previous scrape.
//
// collect() is a regular function, never an arrow — the library invokes it
// with `this` bound to the metric (client_js README binding note). Labeled
// gauges clear via reset(); the unlabelled gauges clear via remove()
// (reset() would render a lying 0 for the null/absent case, remove()
// renders absence).
// ---------------------------------------------------------------------------

/** Breaker state name -> exposition code (plan contract: 0/1/2). */
const BREAKER_STATE_CODE = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 } as const;

export interface MetricsRegistryDeps {
  /** The boot-owned queue set — gauges read lane depth/age/stalls through it. */
  queues: WorkerQueueSet;
  /** The boot-owned Redis client — ONE INFO read per scrape (memory gauge). */
  redis: Pick<Redis, "info">;
}

export function createMetricsRegistry(deps: MetricsRegistryDeps): client.Registry {
  const registry = new client.Registry();

  new client.Gauge({
    name: "spidernode_queue_depth",
    help: "Jobs per BullMQ lane by state (wait/prioritized/delayed/active; -1 = depth read failed)",
    labelNames: ["queue", "state"],
    registers: [registry],
    async collect() {
      this.reset();
      try {
        const snap = await collectQueueMetrics(deps.queues);
        for (const [lane, gauge] of Object.entries(snap.queues)) {
          for (const [state, count] of Object.entries(gauge.depth)) {
            this.set({ queue: lane, state }, count);
          }
        }
      } catch {
        /* absent samples — visible degradation, never a failed scrape */
      }
    },
  });

  new client.Gauge({
    name: "spidernode_queue_oldest_job_age_seconds",
    help: "Age in seconds of the oldest pending (wait+prioritized) job per lane; absent when nothing is pending",
    labelNames: ["queue"],
    registers: [registry],
    async collect() {
      this.reset();
      try {
        const snap = await collectQueueMetrics(deps.queues);
        for (const [lane, gauge] of Object.entries(snap.queues)) {
          if (gauge.oldestWaitingJobAgeMs !== null) {
            this.set({ queue: lane }, gauge.oldestWaitingJobAgeMs / 1000);
          }
        }
      } catch {
        /* absent samples */
      }
    },
  });

  new client.Gauge({
    name: "spidernode_queue_stalled_events",
    help: "BullMQ stall events observed per lane since process start (monotonic counter exposed as a gauge)",
    labelNames: ["queue"],
    registers: [registry],
    async collect() {
      this.reset();
      try {
        const snap = await collectQueueMetrics(deps.queues);
        for (const [lane, gauge] of Object.entries(snap.queues)) {
          this.set({ queue: lane }, gauge.stalledCount);
        }
      } catch {
        /* absent samples */
      }
    },
  });

  new client.Gauge({
    name: "spidernode_outbox_unsent",
    help: "Outbox rows the relay will still pick up (-1 = collector failed)",
    registers: [registry],
    async collect() {
      this.remove();
      try {
        const snap = await collectOutboxMetrics();
        this.set(snap.unsent);
      } catch {
        /* absent sample */
      }
    },
  });

  new client.Gauge({
    name: "spidernode_outbox_failed",
    help: "Terminally FAILED outbox rows awaiting operator re-drive (-1 = collector failed)",
    registers: [registry],
    async collect() {
      this.remove();
      try {
        const snap = await collectOutboxMetrics();
        this.set(snap.failed);
      } catch {
        /* absent sample */
      }
    },
  });

  new client.Gauge({
    name: "spidernode_outbox_oldest_age_seconds",
    help: "Age in seconds of the oldest unsent non-FAILED outbox row; absent when nothing is unsent, -1 on read failure",
    registers: [registry],
    async collect() {
      this.remove();
      try {
        const snap = await collectOutboxMetrics();
        if (snap.oldestUnsentSeconds !== null) this.set(snap.oldestUnsentSeconds);
      } catch {
        /* absent sample */
      }
    },
  });

  new client.Gauge({
    name: "spidernode_outbox_alert_latency_seconds",
    help: "Transition-to-alert latency (sent_at - created_at) over the recent send sample, by stat",
    labelNames: ["stat"],
    registers: [registry],
    async collect() {
      this.reset();
      try {
        const snap: OutboxMetricsSnapshot = await collectOutboxMetrics();
        const stats: Record<string, number | null> = {
          p50: snap.latency.p50Ms,
          p95: snap.latency.p95Ms,
          avg: snap.latency.avgMs,
        };
        for (const [stat, ms] of Object.entries(stats)) {
          if (ms !== null) this.set({ stat }, ms / 1000);
        }
      } catch {
        /* absent samples */
      }
    },
  });

  new client.Gauge({
    name: "spidernode_redis_memory_percent",
    help: "Redis used_memory as a percent of maxmemory; absent when maxmemory is unset or the read failed",
    registers: [registry],
    async collect() {
      // remove(), not reset(): a reset unlabelled gauge renders a lying 0.
      this.remove();
      try {
        const snap = await redisMemorySnapshot(deps.redis);
        if (snap.memoryPercent !== null) this.set(snap.memoryPercent);
      } catch {
        /* absent sample — redisMemorySnapshot already maps failures to nulls */
      }
    },
  });

  new client.Gauge({
    name: "spidernode_pg_breaker_failures",
    help: "Consecutive Postgres infra failures in the breaker's current run (in-process state)",
    registers: [registry],
    collect() {
      this.set(breakerState().consecutiveFailures);
    },
  });

  new client.Gauge({
    name: "spidernode_pg_breaker_state",
    help: "Postgres breaker state: 0 closed, 1 half-open, 2 open",
    registers: [registry],
    collect() {
      this.set(BREAKER_STATE_CODE[breakerState().state]);
    },
  });

  return registry;
}
