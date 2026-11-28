import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from './auth.js';

const HOUR_MS = 60 * 60_000;
const TOKEN_TTL_MS = 5 * 60_000;
const VERIFY_TIMEOUT_MS = 5_000;
const TRACKING_LIMIT = 10_000;
const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const signupTokenSchema = z.string().min(1).max(2048).optional();
const siteverifyResponse = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
});

export interface SignupSettings {
  maxPerHour: number;
  turnstile: { siteKey: string; secretKey: string; hostname: string } | null;
}

export function readSignupSettings(env = process.env): SignupSettings {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim();
  const hostname = env.TURNSTILE_HOSTNAME?.trim().toLowerCase();
  const maxPerHour = env.SIGNUP_MAX_PER_HOUR?.trim()
    ? Number(env.SIGNUP_MAX_PER_HOUR)
    : 5;
  if (
    !Number.isSafeInteger(maxPerHour) ||
    maxPerHour < 1 ||
    maxPerHour > TRACKING_LIMIT
  )
    throw new Error(
      `SIGNUP_MAX_PER_HOUR must be an integer from 1 to ${TRACKING_LIMIT}`,
    );
  if (!siteKey && !secretKey && !hostname)
    return { maxPerHour, turnstile: null };
  if (!siteKey || !secretKey || !hostname)
    throw new Error(
      'Set TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY and TURNSTILE_HOSTNAME together',
    );
  if (
    hostname.length > 253 ||
    hostname
      .split('.')
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Error(
      'TURNSTILE_HOSTNAME must be a hostname without a scheme, port or path',
    );
  return { maxPerHour, turnstile: { siteKey, secretKey, hostname } };
}

interface SignupQuota {
  createdAt: number[];
  pending: number;
}

export class SignupGuard {
  private quotas = new Map<string, SignupQuota>();
  private quotaCount = 0;
  private nextQuotaSweep = 0;
  private usedTokens = new Map<string, number>();
  private nextTokenSweep = 0;

  constructor(
    private settings: SignupSettings,
    private fetchVerify: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  get siteKey() {
    return this.settings.turnstile?.siteKey ?? null;
  }

  async create<Result>(
    ip: string,
    token: string | undefined,
    createIdentity: () => Result | Promise<Result>,
  ) {
    const quota = this.reserve(ip);
    try {
      await this.verify(ip, token);
      const result = await createIdentity();
      // Keep the reserved slot as a successful creation at commit time.
      quota.createdAt.push(this.now());
      this.quotaCount++;
      return result;
    } finally {
      quota.pending--;
      this.quotaCount--;
      if (!quota.pending && !quota.createdAt.length) this.quotas.delete(ip);
    }
  }

  private removeExpiredSignups(ip: string, quota: SignupQuota, now: number) {
    let expired = 0;
    while (
      expired < quota.createdAt.length &&
      quota.createdAt[expired]! + HOUR_MS <= now
    )
      expired++;
    if (expired) {
      quota.createdAt.splice(0, expired);
      this.quotaCount -= expired;
    }
    if (!quota.pending && !quota.createdAt.length) this.quotas.delete(ip);
  }

  private reserve(ip: string) {
    const now = this.now();
    const existing = this.quotas.get(ip);
    if (existing) this.removeExpiredSignups(ip, existing, now);
    if (this.quotaCount >= TRACKING_LIMIT && now >= this.nextQuotaSweep) {
      for (const [ip, quota] of this.quotas)
        this.removeExpiredSignups(ip, quota, now);
      this.nextQuotaSweep = now + 1000;
    }
    const quota = this.quotas.get(ip) ?? { createdAt: [], pending: 0 };
    if (quota.createdAt.length + quota.pending >= this.settings.maxPerHour)
      throw new HttpError(429, '此网络创建账号次数过多，请稍后重试');
    if (this.quotaCount >= TRACKING_LIMIT)
      throw new HttpError(429, '创建账号请求过多，请稍后重试');
    quota.pending++;
    this.quotaCount++;
    this.quotas.set(ip, quota);
    return quota;
  }

  private async verify(ip: string, token: string | undefined) {
    const settings = this.settings.turnstile;
    if (!settings) return;
    if (!token) throw new HttpError(400, '请先完成人机验证');
    const digest = createHash('sha256').update(token).digest('hex');
    const now = this.now();
    if ((this.usedTokens.get(digest) ?? 0) > now)
      throw new HttpError(400, '人机验证已使用，请重新验证');
    if (now >= this.nextTokenSweep) {
      for (const [digest, expiresAt] of this.usedTokens)
        if (expiresAt <= now) this.usedTokens.delete(digest);
      this.nextTokenSweep = now + 1000;
    }
    if (this.usedTokens.size >= TRACKING_LIMIT && !this.usedTokens.has(digest))
      throw new HttpError(429, '创建账号请求过多，请稍后重试');

    // Siteverify's replay detection has a propagation delay. Reserve locally
    // before the call, then retain consumed or uncertain redemptions for a TTL.
    this.usedTokens.set(digest, Infinity);
    let result: z.infer<typeof siteverifyResponse>;
    try {
      const response = await this.fetchVerify(SITEVERIFY_URL, {
        method: 'POST',
        redirect: 'error',
        body: new URLSearchParams({
          secret: settings.secretKey,
          response: token,
          ...(ip && { remoteip: ip }),
        }),
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Siteverify failed');
      }
      result = siteverifyResponse.parse(await response.json());
    } catch {
      throw new HttpError(503, '人机验证暂时不可用，请稍后重试');
    } finally {
      this.usedTokens.set(digest, this.now() + TOKEN_TTL_MS);
    }
    if (!result.success) this.usedTokens.delete(digest);
    if (
      !result.success ||
      result.hostname?.toLowerCase() !== settings.hostname ||
      result.action !== 'signup'
    )
      throw new HttpError(400, '人机验证失败，请重新验证');
  }
}
