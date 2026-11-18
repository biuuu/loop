import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Auth, COOKIE, SESSION_SECONDS } from './auth.js';
export function setSession(reply: FastifyReply, token: string) {
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: SESSION_SECONDS,
  });
}
export function authRoutes(app: FastifyInstance, auth: Auth) {
  app.get('/api/me', async (request) => ({
    guest: (() => {
      const guest = authGuest(request.cookies[COOKIE]);
      return guest ? auth.profile(guest) : null;
    })(),
    auth: { emailEnabled: auth.enabled },
  }));
  function authGuest(token?: string) {
    try {
      return auth.identity(token);
    } catch {
      return null;
    }
  }
  app.post('/api/auth/email/request', async (request) => {
    const { email, purpose } = z
      .object({
        email: z.string().trim().toLowerCase().email().max(254),
        purpose: z.enum(['login', 'bind']),
      })
      .strict()
      .parse(request.body);
    return auth.request(email, purpose, request.cookies[COOKIE], request.ip);
  });
  app.post('/api/auth/email/verify', async (request, reply) => {
    const { challengeId, code } = z
      .object({
        challengeId: z.string().uuid(),
        code: z.string().regex(/^\d{6}$/),
      })
      .strict()
      .parse(request.body);
    const result = auth.verify(challengeId, code, request.cookies[COOKIE]);
    setSession(reply, result.token);
    return {
      guest: result.guest,
      ...(result.createdRoom ? { createdRoom: result.createdRoom } : {}),
    };
  });
  for (const all of [false, true])
    app.post(
      `/api/auth/${all ? 'logout-all' : 'logout'}`,
      async (request, reply) => {
        auth.logout(request.cookies[COOKIE], all);
        reply.clearCookie(COOKIE, { path: '/' });
        return { ok: true };
      },
    );
}
