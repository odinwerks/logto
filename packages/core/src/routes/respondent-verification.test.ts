import { PredefinedScope } from '@logto/schemas';
import { pickDefault } from '@logto/shared/esm';

import { MockTenant } from '#src/test-utils/tenant.js';
import { createRequester } from '#src/utils/test-utils.js';

import type { ManagementApiRouter, RouterInitArgs } from './types.js';

const { jest } = import.meta;

const findUserStatusById = jest.fn();
const findExactSessionActivity = jest.fn();
const tenantContext = new MockTenant(undefined, {
  users: { findUserStatusById },
  oidcSessionExtensions: { findExactSessionActivity },
});
const respondentVerificationRoutes = await pickDefault(import('./respondent-verification.js'));
const getScopes = jest.fn(() => new Set<string>());

const scopedRoutes = <T extends ManagementApiRouter>(...[router, tenant]: RouterInitArgs<T>) => {
  router.use(async (ctx, next) => {
    ctx.auth = { type: 'app', id: 'verifier', scopes: getScopes() };
    return next();
  });
  respondentVerificationRoutes(router, tenant);
};

describe('respondent verification routes', () => {
  const requester = createRequester({ authedRoutes: scopedRoutes, tenantContext });

  beforeEach(() => {
    getScopes.mockReturnValue(
      new Set([PredefinedScope.UsersReadStatus, PredefinedScope.SessionsRead])
    );
    findUserStatusById.mockResolvedValue({ id: 'user_id', isSuspended: false });
    findExactSessionActivity.mockResolvedValue({
      state: 'found',
      evaluatedAt: Date.parse('2026-08-29T12:00:00.000Z'),
      session: {
        sessionExpiresAt: Date.parse('2026-08-29T13:00:00.000Z'),
        lastActiveAt: Date.parse('2026-08-29T11:58:30.000Z'),
      },
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns only the minimal active user status contract', async () => {
    const response = await requester.get('/users/user_id/status');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toStrictEqual({ contractVersion: 1, id: 'user_id', status: 'active' });
  });

  it('returns suspended without exposing a profile', async () => {
    findUserStatusById.mockResolvedValueOnce({ id: 'user_id', isSuspended: true });

    const response = await requester.get('/users/user_id/status');

    expect(response.body).toStrictEqual({
      contractVersion: 1,
      id: 'user_id',
      status: 'suspended',
    });
  });

  it('enforces the route-specific user status scope', async () => {
    getScopes.mockReturnValue(new Set([PredefinedScope.SessionsRead]));

    const response = await requester.get('/users/user_id/status');

    expect(response.status).toBe(403);
    expect(findUserStatusById).not.toHaveBeenCalled();
  });

  it('accepts an exact session at the inactivity boundary', async () => {
    const response = await requester.post('/users/user_id/session-verifications').send({
      clientId: 'client_id',
      sid: 'sid',
      maxInactivitySeconds: 90,
    });

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      contractVersion: 1,
      valid: true,
      evaluatedAt: '2026-08-29T12:00:00.000Z',
      sessionExpiresAt: '2026-08-29T13:00:00.000Z',
      lastActiveAt: '2026-08-29T11:58:30.000Z',
      inactivitySeconds: 90,
      maxInactivitySeconds: 90,
    });
    expect(findExactSessionActivity).toHaveBeenCalledWith('user_id', 'client_id', 'sid');
  });

  it('coarsens stale, duplicate, missing, and suspended sessions to not_active', async () => {
    findExactSessionActivity.mockResolvedValueOnce({
      state: 'ambiguous',
      evaluatedAt: Date.parse('2026-08-29T12:00:00.000Z'),
    });

    const response = await requester.post('/users/user_id/session-verifications').send({
      clientId: 'client_id',
      sid: 'sid',
      maxInactivitySeconds: 90,
    });

    expect(response.body).toStrictEqual({
      contractVersion: 1,
      valid: false,
      reason: 'not_active',
      evaluatedAt: '2026-08-29T12:00:00.000Z',
      maxInactivitySeconds: 90,
    });
  });

  it.each([59, 121, 90.5])('rejects invalid maxInactivitySeconds %p', async (value) => {
    const response = await requester.post('/users/user_id/session-verifications').send({
      clientId: 'client_id',
      sid: 'sid',
      maxInactivitySeconds: value,
    });

    expect(response.status).toBe(400);
    expect(findExactSessionActivity).not.toHaveBeenCalled();
  });

  it('enforces the route-specific session scope', async () => {
    getScopes.mockReturnValue(new Set([PredefinedScope.UsersReadStatus]));

    const response = await requester.post('/users/user_id/session-verifications').send({
      clientId: 'client_id',
      sid: 'sid',
      maxInactivitySeconds: 90,
    });

    expect(response.status).toBe(403);
    expect(findExactSessionActivity).not.toHaveBeenCalled();
  });
});
