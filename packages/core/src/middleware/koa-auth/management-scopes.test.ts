import { PredefinedScope } from '@logto/schemas';
import type { Context } from 'koa';
import type { IRouterParamContext } from 'koa-router';

import RequestError from '#src/errors/RequestError/index.js';
import { createContextWithRouteParameters } from '#src/utils/test-utils.js';

import { requireManagementScopes } from './management-scopes.js';
import type { WithAuthContext } from './types.js';

const { jest } = import.meta;

const forbiddenError = new RequestError({ code: 'auth.forbidden', status: 403 });

const createContext = (scopes: string[]) => {
  const context = createContextWithRouteParameters();

  return {
    ...context,
    auth: { type: 'app' as const, id: 'client', scopes: new Set(scopes) },
  } satisfies WithAuthContext<Context & IRouterParamContext>;
};

describe('requireManagementScopes', () => {
  const next = jest.fn();

  afterEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    [[PredefinedScope.UsersReadStatus], [PredefinedScope.UsersReadStatus]],
    [
      [PredefinedScope.UsersReadStatus, PredefinedScope.SessionsRead],
      [PredefinedScope.UsersReadStatus, PredefinedScope.SessionsRead],
    ],
    [[PredefinedScope.All], [PredefinedScope.UsersReadStatus, PredefinedScope.SessionsRead]],
  ])('allows scopes %p for requirements %p', async (scopes, required) => {
    await requireManagementScopes(...required)(createContext(scopes), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    [[], [PredefinedScope.UsersReadStatus]],
    [[PredefinedScope.SessionsRead], [PredefinedScope.UsersReadStatus]],
    [
      [PredefinedScope.UsersReadStatus],
      [PredefinedScope.UsersReadStatus, PredefinedScope.SessionsRead],
    ],
  ])('denies scopes %p for requirements %p', async (scopes, required) => {
    await expect(
      requireManagementScopes(...required)(createContext(scopes), next)
    ).rejects.toMatchError(forbiddenError);
    expect(next).not.toHaveBeenCalled();
  });
});
