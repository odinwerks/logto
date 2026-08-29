import { adminTenantId, defaultManagementApi, PredefinedScope } from '@logto/schemas';
import type { Optional } from '@silverhand/essentials';
import type { JWK } from 'jose';
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { MiddlewareType, Request } from 'koa';
import type { IMiddleware, IRouterParamContext } from 'koa-router';
import { HTTPError } from 'ky';
import { z } from 'zod';

import { EnvSet } from '#src/env-set/index.js';
import RequestError from '#src/errors/RequestError/index.js';
import assertThat from '#src/utils/assert-that.js';
import { devConsole } from '#src/utils/console.js';

import { type WithAuthContext, type TokenInfo } from './types.js';
import { extractBearerTokenFromHeaders, getAdminTenantTokenValidationSet } from './utils.js';

export * from './types.js';
export * from './constants.js';

const oauthScopeGuard = z
  .string()
  .regex(/^(?:[\u0021\u0023-\u005B\u005D-\u007E]+(?: [\u0021\u0023-\u005B\u005D-\u007E]+)*)?$/u);

export const verifyBearerTokenFromRequest = async (
  envSet: EnvSet,
  request: Request,
  audience: Optional<string>
): Promise<TokenInfo> => {
  const { isProduction, isIntegrationTest, developmentUserId } = EnvSet.values;
  const userId = request.headers['development-user-id']?.toString() ?? developmentUserId;

  if ((!isProduction || isIntegrationTest) && userId) {
    // This log is distracting in integration tests.
    if (!isIntegrationTest) {
      devConsole.warn(`Found dev user ID ${userId}, skip token validation.`);
    }

    return {
      sub: userId,
      clientId: undefined,
      scopes: defaultManagementApi.scopes.map(({ name }) => name),
    };
  }

  const getKeysAndIssuer = async (): Promise<[JWK[], string[]]> => {
    const { publicJwks, issuer } = envSet.oidc;

    if (envSet.tenantId === adminTenantId) {
      return [publicJwks, [issuer]];
    }

    const adminSet = await getAdminTenantTokenValidationSet();

    return [
      [...publicJwks, ...adminSet.keys],
      [issuer, ...adminSet.issuer],
    ];
  };

  try {
    const [keys, issuer] = await getKeysAndIssuer();
    const {
      payload: { sub, client_id: clientId, scope = '', exp },
    } = await jwtVerify(
      extractBearerTokenFromHeaders(request.headers),
      createLocalJWKSet({ keys }),
      {
        issuer,
        audience,
      }
    );

    assertThat(sub, new RequestError({ code: 'auth.jwt_sub_missing', status: 401 }));
    assertThat(
      typeof exp === 'number',
      new RequestError({ code: 'auth.unauthorized', status: 401 })
    );

    const parsedScope = oauthScopeGuard.parse(scope);

    return { sub, clientId, scopes: parsedScope ? parsedScope.split(' ') : [] };
  } catch (error: unknown) {
    if (error instanceof RequestError) {
      throw error;
    }

    /**
     * Handle potential errors when ky makes requests during validation
     * This may occur when fetching OIDC configuration from the oidc-config endpoint
     * `TypeError`: typically thrown when the fetch operation fails (e.g., network issues)
     * `HTTPError`: thrown by ky for non-2xx responses
     */
    if (error instanceof TypeError || error instanceof HTTPError) {
      throw error;
    }

    throw new RequestError({ code: 'auth.unauthorized', status: 401 }, error);
  }
};

export const isKoaAuthMiddleware = <Type extends IMiddleware>(function_: Type) =>
  function_.name === 'authMiddleware';

export function koaManagementApiAuth<StateT, ContextT extends IRouterParamContext, ResponseBodyT>(
  envSet: EnvSet,
  audience: string
): MiddlewareType<StateT, WithAuthContext<ContextT>, ResponseBodyT> {
  const authMiddleware: MiddlewareType<StateT, WithAuthContext<ContextT>, ResponseBodyT> = async (
    ctx,
    next
  ) => {
    const { sub, clientId, scopes } = await verifyBearerTokenFromRequest(
      envSet,
      ctx.request,
      audience
    );

    ctx.auth = {
      type: sub === clientId ? 'app' : 'user',
      id: sub,
      scopes: new Set(scopes),
    };

    return next();
  };

  return authMiddleware;
}

export default function koaAuth<StateT, ContextT extends IRouterParamContext, ResponseBodyT>(
  envSet: EnvSet,
  audience: string
): MiddlewareType<StateT, WithAuthContext<ContextT>, ResponseBodyT> {
  const authMiddleware: MiddlewareType<StateT, WithAuthContext<ContextT>, ResponseBodyT> = async (
    ctx,
    next
  ) => {
    return koaManagementApiAuth<StateT, ContextT, ResponseBodyT>(envSet, audience)(
      ctx,
      async () => {
        assertThat(
          ctx.auth.scopes.has(PredefinedScope.All),
          new RequestError({ code: 'auth.forbidden', status: 403 })
        );

        return next();
      }
    );
  };

  return authMiddleware;
}
