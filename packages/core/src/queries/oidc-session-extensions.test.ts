import { createMockPool, createMockQueryResult } from '@silverhand/slonik';

import type { QueryType } from '#src/utils/test-utils.js';

import { OidcSessionExtensionsQueries } from './oidc-session-extensions.js';

const { jest } = import.meta;

const mockQuery: jest.MockedFunction<QueryType> = jest.fn();
const queries = new OidcSessionExtensionsQueries(
  createMockPool({ query: async (sql, values) => mockQuery(sql, values) })
);

describe('findExactSessionActivity', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns the exact raw timestamps for one tuple match', async () => {
    mockQuery.mockResolvedValueOnce(
      createMockQueryResult([{ evaluatedAt: 2000, sessionExpiresAt: 3000, lastActiveAt: 1000 }])
    );

    await expect(queries.findExactSessionActivity('user', 'client', 'sid')).resolves.toEqual({
      state: 'found',
      evaluatedAt: 2000,
      session: { sessionExpiresAt: 3000, lastActiveAt: 1000 },
    });
    expect(mockQuery.mock.calls[0]?.[1]).toEqual(['user', 'Session', 'user', 'client', 'sid']);
  });

  it('detects zero tuple matches', async () => {
    mockQuery.mockResolvedValueOnce(
      createMockQueryResult([{ evaluatedAt: 2000, sessionExpiresAt: null, lastActiveAt: null }])
    );

    await expect(queries.findExactSessionActivity('user', 'client', 'sid')).resolves.toEqual({
      state: 'not_found',
      evaluatedAt: 2000,
    });
  });

  it('detects multiple tuple matches', async () => {
    mockQuery.mockResolvedValueOnce(
      createMockQueryResult([
        { evaluatedAt: 2000, sessionExpiresAt: 3000, lastActiveAt: 1000 },
        { evaluatedAt: 2000, sessionExpiresAt: 4000, lastActiveAt: 1500 },
      ])
    );

    await expect(queries.findExactSessionActivity('user', 'client', 'sid')).resolves.toEqual({
      state: 'ambiguous',
      evaluatedAt: 2000,
    });
  });
});
