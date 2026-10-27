import errors from '@tryghost/errors';
import { Queue, Worker } from 'bullmq';
import type { Job as BullJob, RedisOptions } from 'bullmq';
import { JobsBackendBase } from '@tryghost/adapter-base-jobs';
import type {
  JobProcessor,
  JobEnvelope,
  DispatchEnvelope,
  JobsStartOptions,
  RecurringSchedule,
  JobsShutdownOptions,
} from '@tryghost/adapter-base-jobs';

const logging = require('@tryghost/logging');

// Durable jobs on Redis, selected with adapters:jobs:active = "BullMQJobsBackend"
// and configured under adapters:jobs:BullMQJobsBackend (see defaults.json).
//
// - `connection` is passed through to ioredis. It is deliberately never
//   borrowed from the cache Redis config: the queue needs AOF persistence and
//   maxmemory-policy noeviction, while the cache tolerates eviction.
// - `prefix` namespaces every key. Sites that share one Redis must set distinct
//   prefixes, or they will consume each other's jobs.
// - `concurrency` is per container, per lane. There is no global concurrency.

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const DEFAULT_PREFIX = 'ghost';
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_LOCK_DURATION_MS = 30000;
const DEFAULT_STALLED_INTERVAL_MS = 30000;
const DEFAULT_MAX_STALLED_COUNT = 1;
// A producer waits for its first connection, which never comes when Redis is
// down, so enqueue gives up after this long instead of hanging its caller.
const ENQUEUE_TIMEOUT_MS = 2000;
// Cap on the shutdown bookkeeping of jobs another container may have claimed
const MAX_UNCLAIMED = 1000;
// Envelopes with no routing share this lane; routing to "default" by name is
// the same lane, not a collision.
const DEFAULT_QUEUE = 'default';

interface ConnectionConfig {
  host?: unknown;
  port?: unknown;
  username?: unknown;
  password?: unknown;
  db?: unknown;
  tls?: unknown;
}

interface BullMQJobsBackendConfig {
  connection?: ConnectionConfig;
  prefix?: unknown;
  concurrency?: unknown;
  lockDuration?: unknown;
  stalledInterval?: unknown;
  maxStalledCount?: unknown;
  timezone?: unknown;
}

interface Lane {
  queue: Queue;
  worker: Worker;
}

function invalid(field: string, value: unknown, expected: string): errors.IncorrectUsageError {
  return new errors.IncorrectUsageError({
    message: `Invalid jobs backend ${field}: ${JSON.stringify(value)}. Expected ${expected}.`,
  });
}

function resolveInteger(field: string, value: unknown, fallback: number, min: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw invalid(field, value, min === 0 ? 'a non-negative integer' : 'a positive integer');
  }
  return value;
}

function resolvePrefix(value: unknown): string {
  if (value === undefined || value === null) {
    return DEFAULT_PREFIX;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid('prefix', value, 'a non-empty string');
  }
  return value;
}

// Cron schedules are read in this zone: the configured one, else the process's.
function resolveTimezone(value: unknown): string {
  if (value === undefined || value === null) {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  if (typeof value !== 'string' || !isKnownTimezone(value)) {
    throw invalid('timezone', value, 'an IANA timezone name');
  }
  return value;
}

function isKnownTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function resolveConnection(config: ConnectionConfig = {}): RedisOptions {
  const { host, port, username, password, db, tls } = config;
  const options: RedisOptions = {};
  if (host !== undefined && host !== null) {
    if (typeof host !== 'string' || host.length === 0) {
      throw invalid('connection.host', host, 'a non-empty string');
    }
    options.host = host;
  }
  if (port !== undefined && port !== null) {
    options.port = resolveInteger('connection.port', port, 0, 1);
  }
  if (db !== undefined && db !== null) {
    options.db = resolveInteger('connection.db', db, 0, 0);
  }
  for (const [field, value] of [
    ['username', username],
    ['password', password],
  ] as const) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== 'string') {
      throw invalid(`connection.${field}`, value, 'a string');
    }
    options[field] = value;
  }
  if (tls === true) {
    options.tls = {};
  } else if (tls && typeof tls === 'object') {
    options.tls = tls;
  } else if (tls !== undefined && tls !== null && tls !== false) {
    throw invalid('connection.tls', tls, 'a boolean or an options object');
  }
  return options;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Work only flows between start() and shutdown(): boot starts the service
// before the web app is mounted or any recurring job is scheduled, so an
// enqueue or recurring registration before start() is a boot-ordering bug and
// throws, while an enqueue after shutdown() is a benign shutdown race and is
// dropped.
export default class BullMQJobsBackend extends JobsBackendBase {
  readonly durable = true;

  private _processor: JobProcessor | null;
  private _stopped: boolean;
  private _prefix: string;
  private _connection: RedisOptions;
  private _defaultConcurrency: number;
  private _lockDuration: number;
  private _stalledInterval: number;
  private _maxStalledCount: number;
  private _timezone: string;
  private _lanes: Map<string, Lane>;
  // Jobs this instance enqueued that no worker has picked up yet, and the
  // deliveries running now. Shutdown waits on both, within its time budget.
  private _unclaimed: Map<string, Lane>;
  private _inflight: Set<Promise<void>>;

  constructor(config: BullMQJobsBackendConfig = {}) {
    super();
    this._processor = null;
    this._stopped = false;
    this._prefix = resolvePrefix(config.prefix);
    this._connection = resolveConnection(config.connection);
    this._defaultConcurrency = resolveInteger(
      'concurrency',
      config.concurrency,
      DEFAULT_CONCURRENCY,
      1,
    );
    this._lockDuration = resolveInteger(
      'lockDuration',
      config.lockDuration,
      DEFAULT_LOCK_DURATION_MS,
      1,
    );
    this._stalledInterval = resolveInteger(
      'stalledInterval',
      config.stalledInterval,
      DEFAULT_STALLED_INTERVAL_MS,
      1,
    );
    this._maxStalledCount = resolveInteger(
      'maxStalledCount',
      config.maxStalledCount,
      DEFAULT_MAX_STALLED_COUNT,
      0,
    );
    this._timezone = resolveTimezone(config.timezone);
    this._lanes = new Map();
    this._unclaimed = new Map();
    this._inflight = new Set();
  }

  // Producers fail fast when Redis is down, so enqueue rejects promptly and the
  // outbox relay (or the direct path) decides what happens to the job.
  private _producerConnection(): RedisOptions {
    return {
      ...this._connection,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    };
  }

  // Workers wait for Redis forever and pick up again when it returns.
  private _workerConnection(): RedisOptions {
    return { ...this._connection, maxRetriesPerRequest: null };
  }

  private _makeLane(name: string, concurrency: number): Lane {
    const queue = new Queue(name, {
      connection: this._producerConnection(),
      prefix: this._prefix,
    });
    const worker = new Worker(name, (bullJob) => this._deliver(bullJob), {
      connection: this._workerConnection(),
      prefix: this._prefix,
      concurrency,
      lockDuration: this._lockDuration,
      stalledInterval: this._stalledInterval,
      maxStalledCount: this._maxStalledCount,
    });
    // Without listeners a Redis connection error would be an unhandled 'error' event
    worker.on('active', (bullJob) => this._unclaimed.delete(String(bullJob.id)));
    queue.on('error', (err) => logging.error(`Jobs queue "${name}" error`, err));
    worker.on('error', (err) => logging.error(`Jobs worker "${name}" error`, err));
    return { queue, worker };
  }

  start({ processor, queues }: JobsStartOptions): void {
    const declared = new Map<string, number>();
    for (const [name, { concurrency }] of Object.entries(queues ?? {})) {
      // A declaration the backend cannot satisfy must fail loudly here, never
      // silently fall back (see the jobs-base README).
      if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
        throw new errors.IncorrectUsageError({
          message: `Invalid concurrency for declared queue "${name}": ${JSON.stringify(concurrency)}. Expected a positive integer.`,
        });
      }
      declared.set(name, concurrency ?? this._defaultConcurrency);
    }

    // State only changes once every declaration is valid, so a rejected
    // start() never leaves a partially started backend that accepts work.
    this._processor = processor;
    this._stopped = false;
    for (const [name, concurrency] of declared) {
      this._lanes.set(name, this._makeLane(name, concurrency));
    }
    if (!this._lanes.has(DEFAULT_QUEUE)) {
      this._lanes.set(DEFAULT_QUEUE, this._makeLane(DEFAULT_QUEUE, this._defaultConcurrency));
    }
  }

  private _lane(name: string): Lane {
    let lane = this._lanes.get(name);
    if (!lane) {
      // Lanes are created lazily for any queue name no handler declared, at the
      // default concurrency.
      lane = this._makeLane(name, this._defaultConcurrency);
      this._lanes.set(name, lane);
    }
    return lane;
  }

  async enqueue(id: string, envelope: DispatchEnvelope): Promise<void> {
    if (this._stopped) {
      return;
    }
    const { job, routing } = envelope.payload;
    if (!this._processor) {
      throw new errors.IncorrectUsageError({
        message: `Cannot enqueue job "${job.type}" before the jobs backend is started.`,
      });
    }
    const lane = this._lane(routing?.queue ?? DEFAULT_QUEUE);
    // The dispatch id is the job id: the outbox relay resubmits the same id, so
    // BullMQ dedupes for as long as the job key exists.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        lane.queue.add(job.type, job, { jobId: id }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new errors.InternalServerError({
                message: `Timed out enqueueing job "${job.type}": Redis is unavailable.`,
              }),
            );
          }, ENQUEUE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    this._unclaimed.set(id, lane);
    if (this._unclaimed.size > MAX_UNCLAIMED) {
      this._unclaimed.delete(this._unclaimed.keys().next().value!);
    }
  }

  private async _deliver(bullJob: BullJob<JobEnvelope>): Promise<void> {
    const delivery = this._processor!(bullJob.data);
    const tracked = delivery.then(
      () => undefined,
      () => undefined,
    );
    this._inflight.add(tracked);
    try {
      await delivery;
    } catch (err) {
      logging.error(`Job "${bullJob.data.type}" delivery failed`, err);
      // Rethrow so BullMQ records the failed attempt
      throw err;
    } finally {
      this._inflight.delete(tracked);
    }
  }

  // The in-memory backend starts a job the moment it is enqueued; a BullMQ
  // worker fetches asynchronously. Give jobs this instance just enqueued the
  // chance to be claimed before the workers stop fetching.
  private async _awaitClaimed(): Promise<void> {
    while (this._unclaimed.size > 0) {
      for (const [id, { queue }] of [...this._unclaimed]) {
        const state = await queue.getJobState(id);
        if (state !== 'waiting' && state !== 'prioritized') {
          this._unclaimed.delete(id);
        }
      }
      await delay(10);
    }
  }

  private async _awaitInflight(): Promise<void> {
    while (this._inflight.size > 0) {
      await Promise.all([...this._inflight]);
    }
  }

  async scheduleRecurring(envelope: DispatchEnvelope, { cron }: RecurringSchedule): Promise<void> {
    if (this._stopped) {
      return;
    }
    const { job, routing } = envelope.payload;
    if (!this._processor) {
      throw new errors.IncorrectUsageError({
        message: `Cannot schedule recurring job "${job.type}" before the jobs backend is started.`,
      });
    }
    const { queue } = this._lane(routing?.queue ?? DEFAULT_QUEUE);
    // First schedule per type wins, even when the cron differs: a re-registration
    // (every boot, every container) must not disturb a schedule already in Redis.
    // Check-then-upsert is not atomic, so two containers booting at the same
    // moment with different crons can race; identical crons are harmless.
    if (await queue.getJobScheduler(job.type)) {
      return;
    }
    await queue.upsertJobScheduler(
      job.type,
      { pattern: cron, tz: this._timezone },
      { name: job.type, data: job },
    );
  }

  async shutdown(options: JobsShutdownOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this._stopped = true;

    const lanes = [...this._lanes.values()];
    this._lanes = new Map();

    const drained = await Promise.race([
      (async () => {
        await this._awaitClaimed();
        await Promise.all(lanes.map(({ worker }) => worker.pause(true)));
        await this._awaitInflight();
        return true;
      })().catch(() => false),
      delay(timeoutMs).then(() => false),
    ]);
    // A hung handler's job stays locked; BullMQ's stalled-job handling recovers
    // it once the lock expires, on the next container or boot. Closing with
    // force skips waiting for it.
    await Promise.all(lanes.map(({ worker }) => worker.close(!drained)));
    await Promise.all(lanes.map(({ queue }) => queue.close()));
    this._unclaimed = new Map();
    this._inflight = new Set();
    this._processor = null;
  }
}
