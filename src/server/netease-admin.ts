import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import QRCode from 'qrcode';
import {
  createNeteaseQrRequest,
  type NeteaseFetch,
} from './netease-protocol.js';

const CHALLENGE_MS = 180_000;
const COOKIE_NAME = /^(MUSIC_U|__csrf)$/;
const COOKIE_VALUE = /^[^;\r\n\x00-\x1f\x7f]{1,4096}$/;

function cleanCookie(value: string) {
  const found = new Map<string, string>();
  for (const part of value.split(';')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    const token = part.slice(at + 1).trim();
    if (COOKIE_NAME.test(name) && COOKIE_VALUE.test(token))
      found.set(name, token);
  }
  return found.has('MUSIC_U')
    ? `MUSIC_U=${found.get('MUSIC_U')}${found.has('__csrf') ? `; __csrf=${found.get('__csrf')}` : ''}`
    : '';
}

export class NeteaseCredentialStore {
  private value: string;
  readonly file: string;
  constructor(
    file = process.env.NETEASE_COOKIE_FILE || 'data/netease-cookie',
    fallback = process.env.NETEASE_COOKIE || '',
  ) {
    this.file = resolve(file);
    this.value = existsSync(this.file)
      ? cleanCookie(readFileSync(this.file, 'utf8'))
      : fallback;
  }
  get() {
    return this.value;
  }
  configured() {
    return this.value.includes('MUSIC_U=');
  }
  save(raw: string) {
    const value = cleanCookie(raw);
    if (!value) throw new Error('Missing MUSIC_U');
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.file);
      chmodSync(this.file, 0o600);
      this.value = value;
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}

export function validAdminKey(supplied: unknown, expected: string | undefined) {
  if (typeof supplied !== 'string' || !expected || expected.length < 32)
    return false;
  const expectedHash = createHash('sha256').update(expected).digest();
  const suppliedHash = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

export class NeteaseQrLogin {
  private challenge?: { key: string; expiresAt: number };
  private readonly request;
  constructor(
    private readonly credentials: NeteaseCredentialStore,
    fetcher?: NeteaseFetch,
    private readonly now = Date.now,
  ) {
    this.request = createNeteaseQrRequest(fetcher);
  }
  status() {
    return { configured: this.credentials.configured() };
  }
  async start() {
    // A new scan invalidates the previous short-lived server-held challenge.
    this.challenge = undefined;
    const { body } = await this.request('unikey');
    const key = body.data?.unikey ?? body.unikey;
    if (
      body.code !== 200 ||
      typeof key !== 'string' ||
      !/^[A-Za-z0-9_-]{8,256}$/.test(key)
    )
      throw new Error('Invalid QR challenge');
    const expiresAt = this.now() + CHALLENGE_MS;
    this.challenge = { key, expiresAt };
    const svg = await QRCode.toString(
      `https://music.163.com/login?codekey=${encodeURIComponent(key)}`,
      {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 240,
      },
    );
    return {
      image: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
      expiresAt,
    };
  }
  async check() {
    const challenge = this.challenge;
    if (!challenge || this.now() >= challenge.expiresAt) {
      this.challenge = undefined;
      return {
        status: 'expired' as const,
        configured: this.credentials.configured(),
      };
    }
    const { body, cookies } = await this.request('check', challenge.key);
    switch (body.code) {
      case 801:
        return {
          status: 'waiting' as const,
          configured: this.credentials.configured(),
        };
      case 802:
        return {
          status: 'scanned' as const,
          configured: this.credentials.configured(),
        };
      case 800:
        this.challenge = undefined;
        return {
          status: 'expired' as const,
          configured: this.credentials.configured(),
        };
      case 803: {
        this.challenge = undefined;
        const selected = cookies
          .map((part) => {
            const match = /^(MUSIC_U|__csrf)=([^;]*)/.exec(part);
            return match ? `${match[1]}=${match[2]}` : '';
          })
          .filter(Boolean)
          .join('; ');
        this.credentials.save(selected);
        return { status: 'success' as const, configured: true };
      }
      default:
        throw new Error('Invalid QR status');
    }
  }
}
