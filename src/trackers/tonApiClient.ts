import axios from 'axios';
import { config } from '../config/config.js';

const TONAPI_BASE = 'https://tonapi.io/v2';

/**
 * TON API is a leaky bucket: cheap endpoints (events, collection items) tolerate
 * short bursts, but heavier ones (nft item lookups) start returning 429 after
 * ~3 rapid calls even with an API key. Keep a conservative sustained pace
 * (~1 req/s) so a batch of lookups can never drain the bucket.
 */
const MIN_INTERVAL_WITH_KEY_MS = 1000;
const MIN_INTERVAL_WITHOUT_KEY_MS = 1100;

const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
const RETRY_AFTER_CAP_MS = 120_000;
const COOLDOWN_LOG_INTERVAL_MS = 30_000;
/** A burst of successes does not prove the limit is gone; wait before resetting. */
const CLEAN_PERIOD_BEFORE_RESET_MS = 3 * 60_000;

export class TonApiRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`TON API rate limit (429), cooling down for ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'TonApiRateLimitError';
  }
}

export function parseRetryAfter(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 120) * 1000;
  const date = Date.parse(String(value));
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), RETRY_AFTER_CAP_MS);
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientTonApiError(err: any): boolean {
  const status = err?.response?.status;
  if (typeof status === 'number' && status >= 500) return true;

  const code = String(err?.code || '');
  if (
    code === 'ECONNRESET' ||
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'EPIPE'
  ) {
    return true;
  }

  const msg = String(err?.message || '').toLowerCase();
  return msg === 'aborted' || msg.includes('socket hang up') || msg.includes('timeout');
}

/**
 * Single gate for every tonapi.io request in the process.
 *
 * All trackers used to call the API independently, so a burst of parallel
 * lookups (events + 5 collections + address resolutions) tripped the rate
 * limiter and produced an endless "429, retrying in 2s..." loop. Requests are
 * now serialized, spaced out, and a 429 puts the whole process into a single
 * escalating cooldown instead of retrying every caller separately.
 */
export class TonApiClient {
  private queue: Promise<void> = Promise.resolve();
  private nextStartAt = 0;
  private cooldownUntil = 0;
  private consecutive429 = 0;
  private last429At = 0;
  private lastCooldownLogAt = 0;
  private clearLogged = false;

  private get minIntervalMs(): number {
    return config.TONAPI_KEY ? MIN_INTERVAL_WITH_KEY_MS : MIN_INTERVAL_WITHOUT_KEY_MS;
  }

  public isCoolingDown(): boolean {
    return Date.now() < this.cooldownUntil;
  }

  public cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  /** GET a TON API path (or a full URL) and return parsed JSON. */
  public async get<T = any>(pathOrUrl: string): Promise<T> {
    if (this.isCoolingDown()) {
      throw new TonApiRateLimitError(this.cooldownRemainingMs());
    }
    return this.enqueue(() => this.request<T>(pathOrUrl));
  }

  private async enqueue<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      const waitMs = this.nextStartAt - Date.now();
      if (waitMs > 0) await delay(waitMs);

      // A previous request may have tripped the limiter while this one queued.
      if (this.isCoolingDown()) {
        throw new TonApiRateLimitError(this.cooldownRemainingMs());
      }

      this.nextStartAt = Date.now() + this.minIntervalMs;
      return await run();
    } finally {
      release();
    }
  }

  private async request<T>(pathOrUrl: string): Promise<T> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${TONAPI_BASE}${pathOrUrl}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (config.TONAPI_KEY) headers['Authorization'] = `Bearer ${config.TONAPI_KEY}`;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await axios.get(url, { headers, timeout: 12000 });
        this.onSuccess();
        return res.data as T;
      } catch (err: any) {
        const status = err?.response?.status;

        if (status === 429) {
          this.onRateLimit(err?.response?.headers?.['retry-after']);
          throw new TonApiRateLimitError(this.cooldownRemainingMs());
        }

        if (isTransientTonApiError(err) && attempt < 2) {
          await delay(600 * (attempt + 1));
          continue;
        }

        throw err;
      }
    }

    throw new Error(`TON API request failed: ${url}`);
  }

  private onRateLimit(retryAfterHeader: unknown): void {
    const now = Date.now();
    this.consecutive429++;
    this.last429At = now;
    this.clearLogged = false;

    const backoff = Math.min(BASE_COOLDOWN_MS * 2 ** (this.consecutive429 - 1), MAX_COOLDOWN_MS);
    const retryAfter = parseRetryAfter(retryAfterHeader) ?? 0;
    const waitMs = Math.max(backoff, retryAfter);

    this.cooldownUntil = now + waitMs;

    // One line per cooldown window instead of one per failed request.
    if (now - this.lastCooldownLogAt > COOLDOWN_LOG_INTERVAL_MS) {
      this.lastCooldownLogAt = now;
      console.warn(
        `⚠️ [TON API] Rate limit (429). Pausing all TON API calls for ${Math.ceil(waitMs / 1000)}s ` +
          `(attempt ${this.consecutive429}).`
      );
    }
  }

  private onSuccess(): void {
    this.cooldownUntil = 0;

    // Do not drop the backoff on the first success: the bucket may still be
    // nearly empty and the next lookup would trip the limiter again. Reset only
    // after a sustained clean period.
    if (this.consecutive429 > 0 && Date.now() - this.last429At > CLEAN_PERIOD_BEFORE_RESET_MS) {
      this.consecutive429 = 0;
      if (!this.clearLogged) {
        this.clearLogged = true;
        console.log('✅ [TON API] Rate limit cleared, resuming normal polling.');
      }
    }
  }
}

export const tonApi = new TonApiClient();
