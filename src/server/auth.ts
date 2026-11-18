import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { Guest, RoomInfo } from '../shared/contracts.js';
import { hashToken, type Store } from './db.js';
import type { SendMail } from './mail.js';

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export const COOKIE = 'loop_guest';
export const SESSION_SECONDS = 365 * 24 * 3600;
const FIVE_MINUTES = 5 * 60_000;
type Challenge = {
  id: string;
  email: string;
  purpose: 'login' | 'bind';
  user_id: string | null;
  session_hash: string | null;
  code_hmac: string;
  expires_at: number;
  attempts: number;
  consumed: number;
};
export function publicGuest(guest: Guest): Guest {
  return {
    id: guest.id,
    nickname: guest.nickname,
    ...(guest.appearance ? { appearance: guest.appearance } : {}),
  };
}
export class Auth {
  readonly enabled: boolean;
  onRevoke: (userId: string, tokenHash?: string) => void = () => {};
  constructor(
    private db: Store,
    private options: {
      sendMail?: SendMail;
      secret?: string;
      now?: () => number;
    } = {},
  ) {
    this.enabled = Boolean(
      options.sendMail && options.secret && options.secret.length >= 32,
    );
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  profile(guest: Guest): Guest {
    const row = this.db.sql
      .prepare(
        "SELECT subject FROM auth_identities WHERE user_id=? AND provider='email'",
      )
      .get(guest.id) as { subject: string } | undefined;
    return {
      ...publicGuest(guest),
      registered: this.registered(guest.id),
      ...(row ? { email: row.subject } : {}),
    };
  }
  registered(userId: string) {
    return Boolean(
      this.db.sql
        .prepare('SELECT 1 FROM auth_identities WHERE user_id=? LIMIT 1')
        .get(userId),
    );
  }
  identity(token?: string) {
    const guest = this.db.guest(token);
    if (!guest) throw new HttpError(401, '请先填写昵称或登录');
    return guest;
  }
  private hmac(id: string, code: string) {
    return createHmac('sha256', this.options.secret!)
      .update(`${id}:${code}`)
      .digest('hex');
  }
  async request(
    email: string,
    purpose: 'login' | 'bind',
    token: string | undefined,
    ip: string,
  ) {
    if (!this.enabled) throw new HttpError(503, '邮箱登录暂未配置');
    const user = purpose === 'bind' ? this.identity(token) : null;
    const now = this.now();
    const recent = this.db.sql
      .prepare(
        'SELECT created_at FROM email_challenges WHERE email=? ORDER BY created_at DESC LIMIT 1',
      )
      .get(email) as { created_at: number } | undefined;
    const requests = this.db.sql
      .prepare(
        'SELECT count(*) AS count FROM email_challenges WHERE ip=? AND created_at>?',
      )
      .get(ip, now - 3600_000) as { count: number };
    const emailRequests = this.db.sql
      .prepare(
        'SELECT count(*) AS count FROM email_challenges WHERE email=? AND created_at>?',
      )
      .get(email, now - 3600_000) as { count: number };
    if (
      (recent && recent.created_at > now - 60_000) ||
      requests.count >= 20 ||
      emailRequests.count >= 10
    )
      throw new HttpError(429, '验证码发送太快，请稍后重试');
    const id = randomUUID(),
      code = String(randomInt(1_000_000)).padStart(6, '0');
    this.db.sql.transaction(() => {
      this.db.sql
        .prepare('UPDATE email_challenges SET consumed=1 WHERE email=?')
        .run(email);
      this.db.sql
        .prepare(
          `INSERT INTO email_challenges (id,email,purpose,user_id,session_hash,code_hmac,created_at,expires_at,ip)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          email,
          purpose,
          user?.id ?? null,
          user ? hashToken(token!) : null,
          this.hmac(id, code),
          now,
          now + FIVE_MINUTES,
          ip,
        );
      // Retain a bounded history for cooldown/rate enforcement, discarding old secrets.
      this.db.sql
        .prepare('DELETE FROM email_challenges WHERE created_at<?')
        .run(now - 24 * 3600_000);
    })();
    try {
      await this.options.sendMail!({ to: email, code, purpose });
    } catch {
      this.db.sql
        .prepare('UPDATE email_challenges SET consumed=1 WHERE id=?')
        .run(id);
      throw new HttpError(502, '邮件发送失败，请稍后重试');
    }
    return { challengeId: id };
  }
  verify(challengeId: string, code: string, token?: string) {
    if (!this.enabled) throw new HttpError(503, '邮箱登录暂未配置');
    let revoked: { userId: string; tokenHash?: string } | undefined;
    // Return errors from the transaction so failed guesses are committed.
    const result = this.db.sql.transaction(() => {
      const challenge = this.db.sql
        .prepare('SELECT * FROM email_challenges WHERE id=?')
        .get(challengeId) as Challenge | undefined;
      if (
        !challenge ||
        challenge.consumed ||
        challenge.expires_at <= this.now() ||
        challenge.attempts >= 5
      )
        return new HttpError(400, '验证码无效或已过期');
      if (challenge.purpose === 'bind') {
        const current = this.db.guest(token);
        if (
          !current ||
          current.id !== challenge.user_id ||
          !token ||
          hashToken(token) !== challenge.session_hash
        )
          return new HttpError(403, '请在发起绑定的会话中验证');
      }
      this.db.sql
        .prepare('UPDATE email_challenges SET attempts=attempts+1 WHERE id=?')
        .run(challengeId);
      if (
        !timingSafeEqual(
          Buffer.from(challenge.code_hmac, 'hex'),
          Buffer.from(this.hmac(challengeId, code), 'hex'),
        )
      )
        return new HttpError(400, '验证码无效或已过期');
      const identity = this.db.sql
        .prepare(
          "SELECT user_id FROM auth_identities WHERE provider='email' AND subject=?",
        )
        .get(challenge.email) as { user_id: string } | undefined;
      if (
        challenge.purpose === 'bind' &&
        identity &&
        identity.user_id !== challenge.user_id
      )
        return new HttpError(409, '该邮箱已绑定其他账号');
      let userId =
        challenge.purpose === 'bind' ? challenge.user_id! : identity?.user_id;
      let createdRoom: RoomInfo | undefined;
      if (!userId) {
        // A successful email login creates its own profile; it never adopts an unrelated guest cookie.
        const created = this.db.createUser('新朋友');
        userId = created.guest.id;
        createdRoom = created.createdRoom;
        this.db.sql.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
      }
      if (!identity)
        this.db.sql
          .prepare('INSERT INTO auth_identities VALUES (?,?,?,?)')
          .run(userId, 'email', challenge.email, this.now());
      if (challenge.purpose === 'bind') {
        this.db.sql.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
        revoked = { userId };
      }
      if (challenge.purpose === 'login' && token) {
        const previous = this.db.guest(token);
        if (previous) {
          const previousHash = hashToken(token);
          this.db.sql
            .prepare('DELETE FROM sessions WHERE token_hash=?')
            .run(previousHash);
          this.db.sql
            .prepare('UPDATE guests SET token_hash=? WHERE token_hash=?')
            .run(hashToken(randomBytes(32).toString('hex')), previousHash);
          revoked = { userId: previous.id, tokenHash: previousHash };
        }
      }
      // Retire the legacy access channel after verified authentication.
      this.db.sql
        .prepare('UPDATE guests SET token_hash=? WHERE id=?')
        .run(hashToken(randomBytes(32).toString('hex')), userId);
      this.db.sql
        .prepare('UPDATE email_challenges SET consumed=1 WHERE id=?')
        .run(challengeId);
      const sessionToken = randomBytes(32).toString('base64url');
      this.db.sql
        .prepare('INSERT INTO sessions VALUES (?,?,?,?,?)')
        .run(
          hashToken(sessionToken),
          userId,
          'email',
          this.now(),
          this.now() + SESSION_SECONDS * 1000,
        );
      return {
        guest: this.profile(this.db.guestById(userId)),
        token: sessionToken,
        ...(createdRoom ? { createdRoom } : {}),
      };
    })();
    if (result instanceof Error) throw result;
    if (revoked) this.onRevoke(revoked.userId, revoked.tokenHash);
    return result;
  }
  logout(token: string | undefined, all = false) {
    const guest = this.db.guest(token);
    if (!guest || !token) return;
    if (all) {
      this.db.sql.prepare('DELETE FROM sessions WHERE user_id=?').run(guest.id);
      this.db.sql
        .prepare('UPDATE guests SET token_hash=? WHERE id=?')
        .run(hashToken(randomBytes(32).toString('hex')), guest.id);
    } else {
      this.db.sql
        .prepare('DELETE FROM sessions WHERE token_hash=?')
        .run(hashToken(token));
      this.db.sql
        .prepare('UPDATE guests SET token_hash=? WHERE token_hash=?')
        .run(hashToken(randomBytes(32).toString('hex')), hashToken(token));
    }
    this.onRevoke(guest.id, all ? undefined : hashToken(token));
  }
}
