/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import crypto from 'crypto';

export interface QuotaConfig {
  maxCharsPerCall: number;
  rpmLimit: number;
  rpdLimit: number;
  tpmLimit: number;
}

export function getQuotaConfig(): QuotaConfig {
  return {
    maxCharsPerCall: Math.max(200, Number(process.env.MAX_CHARS_PER_CALL) || 3000),
    rpmLimit: Math.max(1, Number(process.env.RPM_LIMIT) || 10),
    rpdLimit: Math.max(1, Number(process.env.RPD_LIMIT) || 500),
    tpmLimit: Math.max(1000, Number(process.env.TPM_LIMIT) || 100000),
  };
}

export class RateLimitHttpError extends Error {
  status = 429;
  retryAfterSec: number;
  isDailyLimit: boolean;
  constructor(message: string, retryAfterSec: number, isDailyLimit: boolean = false) {
    super(message);
    this.retryAfterSec = Math.max(1, Math.ceil(retryAfterSec));
    this.isDailyLimit = isDailyLimit;
  }
}

interface ModelLedger {
  requestTimestamps: number[];
  tokenEvents: Array<{ ts: number; tokens: number }>;
  dailyDateKey: string;
  dailyCount: number;
  cooldownUntilMs: number;
  pendingCount: number;
  mutex: Promise<void>;
}

function getUtcDateKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function secondsUntilUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  const nextMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
  return Math.max(1, Math.ceil((nextMidnight - nowMs) / 1000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseRetryAfterSec(err: any): { retryAfterSec: number | null; isDaily: boolean } {
  const msg = String(err?.message || '');
  const isDaily = /per[\s_]?day|requestsPerDay|\bRPD\b/i.test(msg);

  // Inspect structured details if present
  const details = Array.isArray(err?.details) ? err.details : [];
  for (const d of details) {
    if (d?.retryDelay) {
      const m = String(d.retryDelay).match(/([\d.]+)/);
      if (m) return { retryAfterSec: Math.ceil(Number(m[1])), isDaily };
    }
  }

  // Match JSON or prose retry hints in error message
  const jsonRetry = msg.match(/"retryDelay"\s*:\s*"([\d.]+)s?"/i);
  if (jsonRetry) {
    return { retryAfterSec: Math.ceil(Number(jsonRetry[1])), isDaily };
  }

  const proseRetry = msg.match(/retry in\s+([\d.]+)\s*s/i);
  if (proseRetry) {
    return { retryAfterSec: Math.ceil(Number(proseRetry[1])), isDaily };
  }

  return { retryAfterSec: null, isDaily };
}

class ModelRateGate {
  private readonly serverStartMs: number;
  private readonly ledgers = new Map<string, ModelLedger>();

  constructor() {
    this.serverStartMs = Date.now();
  }

  private getLedger(model: string, config: QuotaConfig): ModelLedger {
    let ledger = this.ledgers.get(model);
    const now = Date.now();
    const todayKey = getUtcDateKey(now);

    if (!ledger) {
      // Restart safety: assume the 60s minute window is full for 60s after server start
      // so a restart can never trigger a burst over RPM_LIMIT.
      const warmupTimestamps = Array.from(
        { length: config.rpmLimit },
        () => this.serverStartMs
      );
      ledger = {
        requestTimestamps: warmupTimestamps,
        tokenEvents: [],
        dailyDateKey: todayKey,
        dailyCount: 0,
        cooldownUntilMs: 0,
        pendingCount: 0,
        mutex: Promise.resolve(),
      };
      this.ledgers.set(model, ledger);
    }

    if (ledger.dailyDateKey !== todayKey) {
      ledger.dailyDateKey = todayKey;
      ledger.dailyCount = 0;
    }

    return ledger;
  }

  private pruneWindow(ledger: ModelLedger, now: number) {
    const cutoff = now - 60_000;
    ledger.requestTimestamps = ledger.requestTimestamps.filter((ts) => ts > cutoff);
    ledger.tokenEvents = ledger.tokenEvents.filter((ev) => ev.ts > cutoff);
  }

  public getEstimatedWaitMs(model: string, estimatedTokens: number = 1500): {
    waitMs: number;
    dailyExhausted: boolean;
    retryAfterSec: number;
  } {
    const config = getQuotaConfig();
    const ledger = this.getLedger(model, config);
    const now = Date.now();
    this.pruneWindow(ledger, now);

    if (ledger.dailyCount >= config.rpdLimit) {
      return {
        waitMs: 0,
        dailyExhausted: true,
        retryAfterSec: secondsUntilUtcMidnight(now),
      };
    }

    let waitMs = Math.max(0, ledger.cooldownUntilMs - now);

    const projectedCount = ledger.requestTimestamps.length + ledger.pendingCount;
    if (projectedCount >= config.rpmLimit) {
      const expireIdx = Math.max(0, projectedCount - config.rpmLimit);
      const refTs =
        ledger.requestTimestamps[expireIdx] ?? ledger.requestTimestamps[0] ?? now;
      waitMs = Math.max(waitMs, refTs + 60_000 + 250 - now);
    }

    const usedTokens = ledger.tokenEvents.reduce((sum, ev) => sum + ev.tokens, 0);
    if (ledger.tokenEvents.length > 0 && usedTokens + estimatedTokens > config.tpmLimit) {
      let running = usedTokens;
      for (const ev of ledger.tokenEvents) {
        running -= ev.tokens;
        if (running + estimatedTokens <= config.tpmLimit) {
          waitMs = Math.max(waitMs, ev.ts + 60_000 + 250 - now);
          break;
        }
      }
    }

    return {
      waitMs,
      dailyExhausted: false,
      retryAfterSec: Math.ceil(waitMs / 1000),
    };
  }

  public getRecentCallCount(model: string): number {
    const config = getQuotaConfig();
    const ledger = this.getLedger(model, config);
    this.pruneWindow(ledger, Date.now());
    return ledger.requestTimestamps.length;
  }

  public recordCooldown(model: string, durationMs: number) {
    const config = getQuotaConfig();
    const ledger = this.getLedger(model, config);
    ledger.cooldownUntilMs = Math.max(ledger.cooldownUntilMs, Date.now() + durationMs);
  }

  public markDailyExhausted(model: string) {
    const config = getQuotaConfig();
    const ledger = this.getLedger(model, config);
    ledger.dailyCount = config.rpdLimit;
  }

  public async acquire(
    model: string,
    estimatedTokens: number,
    onWait?: (waitSec: number) => void
  ): Promise<void> {
    const config = getQuotaConfig();
    const ledger = this.getLedger(model, config);

    const prevMutex = ledger.mutex;
    ledger.pendingCount += 1;
    let release!: () => void;
    ledger.mutex = new Promise<void>((res) => {
      release = res;
    });

    await prevMutex;
    try {
      while (true) {
        const now = Date.now();
        this.pruneWindow(ledger, now);

        if (ledger.dailyDateKey !== getUtcDateKey(now)) {
          ledger.dailyDateKey = getUtcDateKey(now);
          ledger.dailyCount = 0;
        }

        if (ledger.dailyCount >= config.rpdLimit) {
          const retryAfter = secondsUntilUtcMidnight(now);
          throw new RateLimitHttpError(
            `Daily request quota (${config.rpdLimit} RPD) reached for ${model}.`,
            retryAfter,
            true
          );
        }

        let waitMs = Math.max(0, ledger.cooldownUntilMs - now);

        if (ledger.requestTimestamps.length >= config.rpmLimit) {
          const oldest = ledger.requestTimestamps[0];
          waitMs = Math.max(waitMs, oldest + 60_000 + 250 - now);
        }

        const usedTokens = ledger.tokenEvents.reduce((sum, ev) => sum + ev.tokens, 0);
        if (ledger.tokenEvents.length > 0 && usedTokens + estimatedTokens > config.tpmLimit) {
          let running = usedTokens;
          for (const ev of ledger.tokenEvents) {
            running -= ev.tokens;
            if (running + estimatedTokens <= config.tpmLimit) {
              waitMs = Math.max(waitMs, ev.ts + 60_000 + 250 - now);
              break;
            }
          }
        }

        if (waitMs > 0) {
          onWait?.(Math.max(1, Math.ceil(waitMs / 1000)));
          await sleep(waitMs);
          continue;
        }

        const commitTs = Date.now();
        ledger.requestTimestamps.push(commitTs);
        ledger.tokenEvents.push({ ts: commitTs, tokens: estimatedTokens });
        ledger.dailyCount += 1;
        return;
      }
    } finally {
      ledger.pendingCount = Math.max(0, ledger.pendingCount - 1);
      release();
    }
  }

  public async execute<T>(
    model: string,
    estimatedTokens: number,
    fn: () => Promise<T>,
    onWait?: (waitSec: number) => void
  ): Promise<T> {
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.acquire(model, estimatedTokens, onWait);
      try {
        return await fn();
      } catch (err: any) {
        const status = err?.status || err?.statusCode;
        const msg = String(err?.message || '');
        const is429 = status === 429 || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('"code":429');
        if (!is429) {
          throw err;
        }

        const { retryAfterSec, isDaily } = parseRetryAfterSec(err);
        if (isDaily) {
          this.markDailyExhausted(model);
          throw new RateLimitHttpError(
            msg || `Daily quota exhausted for ${model}.`,
            secondsUntilUtcMidnight(Date.now()),
            true
          );
        }

        const delaySec = retryAfterSec ?? 20;
        this.recordCooldown(model, (delaySec + 1) * 1000);

        if (attempt === maxRetries) {
          throw new RateLimitHttpError(
            msg || `Rate limit exceeded for ${model}.`,
            delaySec,
            false
          );
        }

        onWait?.(delaySec + 1);
      }
    }
    throw new RateLimitHttpError(`Rate limit exceeded for ${model}.`, 30, false);
  }
}

export const modelRateGate = new ModelRateGate();

// Constant-time access key verification & server-issued HttpOnly session cookie for the Studio UI
const SESSION_SECRET = crypto.randomBytes(32);

export function constantTimeEqual(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export function createStudioSessionToken(): string {
  const issuedAt = String(Date.now());
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = `${issuedAt}.${nonce}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifyStudioSessionToken(token?: string): boolean {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [issuedAtStr, nonce, sig] = parts;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt) || !nonce || !sig) return false;
  // Valid for 24h
  if (Date.now() - issuedAt > 24 * 60 * 60 * 1000) return false;
  const expectedSig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(`${issuedAtStr}.${nonce}`)
    .digest('hex');
  return constantTimeEqual(sig, expectedSig);
}

export function parseCookies(cookieHeader?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}
