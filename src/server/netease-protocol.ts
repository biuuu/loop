/**
 * Minimal EAPI protocol derived from NeteaseCloudMusicApiBackup 4.25.0
 * (util/crypto.js, util/request.js, register_anonimous and music modules).
 * Copyright (c) 2013-2022 Binaryify, MIT. See THIRD_PARTY_NOTICES.md.
 * No separate API server, global anonymous-token file or audio transport.
 */
import {
  constants,
  createCipheriv,
  createHash,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import {
  EnvHttpProxyAgent,
  fetch,
  type RequestInit,
  type Response,
} from 'undici';

const API_ORIGIN = 'https://interface.music.163.com';
const EAPI_KEY = Buffer.from('e82ckenh8dichen8');
const WEAPI_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;
// Apply the same environment proxy settings in development, production and tests.
// This dispatcher is used for metadata requests only; audio stays browser-direct.
const dispatcher = new EnvHttpProxyAgent();
export type NeteaseFetch = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'headers' | 'json'>>;
const upstreamFetch: NeteaseFetch = (url, init) =>
  fetch(url, { ...init, dispatcher });
type Endpoint =
  | '/api/cloudsearch/pc'
  | '/api/v3/song/detail'
  | '/api/v6/playlist/detail'
  | '/api/user/playlist'
  | '/api/song/lyric'
  | '/api/song/enhance/player/url/v1';
export type NeteaseRequest = (
  path: Endpoint,
  data: Record<string, unknown>,
) => Promise<unknown>;

export class NeteaseRequestError extends Error {
  constructor(
    public readonly kind: 'network' | 'http' | 'response',
    public readonly code?: string | number,
  ) {
    super('网易云暂时无法访问，请稍后重试');
    this.name = 'NeteaseRequestError';
  }
}

export function encryptEapi(
  path: string,
  data: Record<string, unknown>,
): string {
  const text = JSON.stringify(data);
  const digest = createHash('md5')
    .update(`nobody${path}use${text}md5forencrypt`)
    .digest('hex');
  const cipher = createCipheriv('aes-128-ecb', EAPI_KEY, null);
  return Buffer.concat([
    cipher.update(`${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`, 'utf8'),
    cipher.final(),
  ])
    .toString('hex')
    .toUpperCase();
}

export function encryptWeapi(
  data: Record<string, unknown>,
  secret = randomBytes(8).toString('hex'),
) {
  const aes = (text: string, key: string) => {
    const cipher = createCipheriv(
      'aes-128-cbc',
      Buffer.from(key),
      Buffer.from('0102030405060708'),
    );
    return Buffer.concat([cipher.update(text), cipher.final()]).toString(
      'base64',
    );
  };
  const padded = Buffer.alloc(128);
  Buffer.from([...secret].reverse().join('')).copy(padded, 112);
  return {
    params: aes(aes(JSON.stringify(data), '0CoJUm6Qyw8W8jud'), secret),
    encSecKey: publicEncrypt(
      { key: WEAPI_PUBLIC_KEY, padding: constants.RSA_NO_PADDING },
      padded,
    ).toString('hex'),
  };
}

export function createNeteaseRequest(
  cookie: string | (() => string) = process.env.NETEASE_COOKIE || '',
  fetcher: NeteaseFetch = upstreamFetch,
): NeteaseRequest {
  const parseCredentials = (value: string) => {
    const credentials: Record<string, string> = {};
    for (const part of value.split(';')) {
      const separator = part.indexOf('=');
      if (separator > 0)
        credentials[part.slice(0, separator).trim()] = part
          .slice(separator + 1)
          .trim();
    }
    return credentials;
  };
  const initialCredentials = parseCredentials(
    typeof cookie === 'function' ? cookie() : cookie,
  );
  const credentials = () =>
    typeof cookie === 'function'
      ? parseCredentials(cookie())
      : initialCredentials;
  let anonymousCredential = '';
  const deviceId =
    initialCredentials.deviceId ||
    randomBytes(26).toString('hex').toUpperCase();
  let anonymous: Promise<void> | undefined;
  let anonymousRetryAt = 0;
  const send = async (
    path: string,
    data: Record<string, unknown>,
    signal: AbortSignal,
  ) => {
    const current = credentials();
    if (!current.MUSIC_U && !current.MUSIC_A && anonymousCredential)
      current.MUSIC_A = anonymousCredential;
    const header: Record<string, string> = {
      os: 'iPhone OS',
      osver: '16.2',
      appver: '9.0.90',
      versioncode: '140',
      channel: 'distribution',
      mobilename: '',
      resolution: '1920x1080',
      buildver: String(Math.floor(Date.now() / 1000)),
      deviceId,
      __csrf: current.__csrf || '',
      requestId: `${Date.now()}_${String(randomBytes(2).readUInt16BE() % 10000).padStart(4, '0')}`,
    };
    for (const key of ['MUSIC_U', 'MUSIC_A'])
      if (current[key]) header[key] = current[key];
    try {
      const registering = path === '/api/register/anonimous';
      const weapi = registering || path === '/api/user/playlist';
      const response = await fetcher(
        weapi
          ? `https://music.163.com/weapi/${path.slice(5)}`
          : `${API_ORIGIN}/eapi/${path.slice(5)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)',
            Referer: 'https://music.163.com/',
            Cookie: Object.entries(header)
              .map(
                ([key, value]) =>
                  `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
              )
              .join('; '),
          },
          body: new URLSearchParams(
            weapi
              ? encryptWeapi({ ...data, csrf_token: header.__csrf })
              : {
                  params: encryptEapi(path, { ...data, header, e_r: false }),
                },
          ),
          signal,
          redirect: 'error',
        },
      );
      if (!response.ok) throw new NeteaseRequestError('http', response.status);
      const body = (await response.json()) as { code?: number };
      if (Number(body.code) !== 200)
        throw new NeteaseRequestError(
          'response',
          Number(body.code) || undefined,
        );
      return { body, cookies: response.headers.getSetCookie() };
    } catch (error) {
      // Never pass upstream errors (which can include credentials) to logs or users.
      if (error instanceof NeteaseRequestError) throw error;
      const cause = error as { name?: string; cause?: { code?: string } };
      throw new NeteaseRequestError('network', cause.cause?.code || cause.name);
    }
  };
  const registerAnonymous = async () => {
    const key = '3go8&$8*3*3h0k(2)2';
    const xored = Array.from(deviceId, (char, index) =>
      String.fromCharCode(
        char.charCodeAt(0) ^ key.charCodeAt(index % key.length),
      ),
    ).join('');
    const digest = createHash('md5').update(xored).digest('base64');
    const username = Buffer.from(`${deviceId} ${digest}`).toString('base64');
    const { cookies } = await send(
      '/api/register/anonimous',
      { username },
      AbortSignal.timeout(2_000),
    );
    const token = cookies
      .map((value) => /^MUSIC_A=([^;]+)/i.exec(value)?.[1])
      .find(Boolean);
    if (!token)
      throw new NeteaseRequestError('response', 'anonymous-cookie-missing');
    anonymousCredential = token;
  };
  return async (path, data) => {
    const signal = AbortSignal.timeout(8_000);
    const current = credentials();
    if (
      !current.MUSIC_U &&
      !current.MUSIC_A &&
      !anonymousCredential &&
      Date.now() >= anonymousRetryAt
    ) {
      // One guest registration per service instance, shared by concurrent requests.
      // Registration failure must not block URLs available without a guest cookie.
      anonymous ??= registerAnonymous()
        .catch(() => {
          anonymousRetryAt = Date.now() + 60_000;
        })
        .finally(() => {
          anonymous = undefined;
        });
      await anonymous;
    }
    return (await send(path, data, signal)).body;
  };
}

export function createNeteaseQrRequest(fetcher: NeteaseFetch = upstreamFetch) {
  // QR creation and polling must describe the same desktop client. A WEAPI
  // request carrying the music-app User-Agent mixes two distinct login flows.
  const deviceId = randomBytes(16).toString('hex');
  return async (path: 'unikey' | 'check', key?: string) => {
    const endpoint =
      path === 'unikey'
        ? '/api/login/qrcode/unikey'
        : '/api/login/qrcode/client/login';
    const header: Record<string, string> = {
      osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
      deviceId,
      os: 'pc',
      appver: '3.1.17.204416',
      versioncode: '140',
      mobilename: '',
      buildver: String(Math.floor(Date.now() / 1000)),
      resolution: '1920x1080',
      __csrf: '',
      channel: 'netease',
      requestId: `${Date.now()}_${String(randomBytes(2).readUInt16BE() % 10000).padStart(4, '0')}`,
    };
    try {
      const response = await fetcher(
        `https://interfacepc.music.163.com/eapi/${endpoint.slice(5)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/124.0.0.0 NeteaseMusicDesktop/3.1.29.205117',
            Cookie: Object.entries(header)
              .map(
                ([name, value]) =>
                  `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
              )
              .join('; '),
          },
          body: new URLSearchParams({
            params: encryptEapi(endpoint, {
              ...(key ? { key } : {}),
              type: 3,
              header,
              e_r: false,
            }),
          }),
          signal: AbortSignal.timeout(8_000),
          redirect: 'error',
        },
      );
      if (!response.ok) throw new NeteaseRequestError('http', response.status);
      return {
        body: (await response.json()) as {
          code?: unknown;
          unikey?: unknown;
          data?: { unikey?: unknown };
        },
        cookies: response.headers.getSetCookie(),
      };
    } catch {
      throw new NeteaseRequestError('network');
    }
  };
}
