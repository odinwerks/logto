import {
  PredefinedScope,
  respondentSessionVerificationRequestGuard,
  respondentSessionVerificationResponseGuard,
  respondentUserStatusResponseGuard,
} from '@logto/schemas';
import { object, string } from 'zod';

import RequestError from '#src/errors/RequestError/index.js';
import { requireManagementScopes } from '#src/middleware/koa-auth/management-scopes.js';
import koaGuard from '#src/middleware/koa-guard.js';
import assertThat from '#src/utils/assert-that.js';

import type { ManagementApiRouter, RouterInitArgs } from './types.js';

const userIdParametersGuard = object({ userId: string().min(1).max(12) });

const toIsoString = (timestamp: number) => new Date(timestamp).toISOString();

export default function respondentVerificationRoutes<T extends ManagementApiRouter>(
  ...[router, { queries }]: RouterInitArgs<T>
) {
  router.get(
    '/users/:userId/status',
    koaGuard({
      params: userIdParametersGuard,
      response: respondentUserStatusResponseGuard,
      status: [200, 403, 404],
    }),
    requireManagementScopes(PredefinedScope.UsersReadStatus),
    async (ctx) => {
      const user = await queries.users.findUserStatusById(ctx.guard.params.userId);

      assertThat(user, new RequestError({ code: 'entity.not_found', status: 404 }));

      ctx.set('Cache-Control', 'no-store');
      ctx.body = {
        contractVersion: 1,
        id: user.id,
        status: user.isSuspended ? 'suspended' : 'active',
      };
    }
  );

  router.post(
    '/users/:userId/session-verifications',
    koaGuard({
      params: userIdParametersGuard,
      body: respondentSessionVerificationRequestGuard,
      response: respondentSessionVerificationResponseGuard,
      status: [200, 403],
    }),
    requireManagementScopes(PredefinedScope.SessionsRead),
    async (ctx) => {
      const { userId } = ctx.guard.params;
      const { clientId, sid, maxInactivitySeconds } = ctx.guard.body;
      const user = await queries.users.findUserStatusById(userId);
      const sessionResult = await queries.oidcSessionExtensions.findExactSessionActivity(
        userId,
        clientId,
        sid
      );
      const result =
        user && !user.isSuspended
          ? sessionResult
          : { state: 'not_found' as const, evaluatedAt: sessionResult.evaluatedAt };
      const { evaluatedAt } = result;

      ctx.set('Cache-Control', 'no-store');

      if (result.state === 'found') {
        const { sessionExpiresAt, lastActiveAt } = result.session;
        const inactivityMilliseconds = evaluatedAt - lastActiveAt;

        if (
          inactivityMilliseconds >= 0 &&
          inactivityMilliseconds <= maxInactivitySeconds * 1000 &&
          sessionExpiresAt > evaluatedAt
        ) {
          ctx.body = {
            contractVersion: 1,
            valid: true,
            evaluatedAt: toIsoString(evaluatedAt),
            sessionExpiresAt: toIsoString(sessionExpiresAt),
            lastActiveAt: toIsoString(lastActiveAt),
            inactivitySeconds: Math.floor(inactivityMilliseconds / 1000),
            maxInactivitySeconds,
          };
          return;
        }
      }

      ctx.body = {
        contractVersion: 1,
        valid: false,
        reason: 'not_active',
        evaluatedAt: toIsoString(evaluatedAt),
        maxInactivitySeconds,
      };
    }
  );
}
