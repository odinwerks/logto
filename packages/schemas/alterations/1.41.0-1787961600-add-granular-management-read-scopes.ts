import { sql } from '@silverhand/slonik';

import type { AlterationScript } from '../lib/types/alteration.js';

import { generateStandardId } from './utils/1716643968-id-generation.js';

const scopeNames = ['users:read-status', 'sessions:read'] as const;
const descriptions = Object.freeze({
  'users:read-status': 'Read whether a user account is active or suspended.',
  'sessions:read': 'Verify an exact user session and its recent activity.',
});

type ManagementResource = {
  tenantId: string;
  id: string;
};

const alteration: AlterationScript = {
  up: async (pool) => {
    const resources = await pool.any<ManagementResource>(sql`
      select tenant_id, id
      from resources
      where indicator = 'https://' || tenant_id || '.logto.app/api'
         or (tenant_id = 'admin' and indicator ~ '^https://[^/]+\\.logto\\.app/api$')
    `);

    await Promise.all(
      resources.flatMap((resource) =>
        scopeNames.map(async (name) =>
          pool.query(sql`
          insert into scopes (tenant_id, id, resource_id, name, description)
          values (${resource.tenantId}, ${generateStandardId()}, ${resource.id}, ${name}, ${descriptions[name]})
          on conflict (tenant_id, resource_id, name) do nothing
        `)
        )
      )
    );
  },
  down: async (pool) => {
    await pool.query(sql`
      delete from scopes
      where name = any(${sql.array([...scopeNames], 'text')})
        and resource_id in (
          select id
          from resources
          where indicator = 'https://' || tenant_id || '.logto.app/api'
             or (tenant_id = 'admin' and indicator ~ '^https://[^/]+\\.logto\\.app/api$')
        )
    `);
  },
};

export default alteration;
