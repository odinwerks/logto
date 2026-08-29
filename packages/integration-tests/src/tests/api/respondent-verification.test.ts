import {
  deleteUser,
  getRespondentUserStatus,
  suspendUser,
  verifyRespondentSession,
} from '#src/api/index.js';
import { createUserByAdmin } from '#src/helpers/index.js';

describe('respondent verification management contract', () => {
  it('returns minimal status and a coarse denial for an unknown exact session', async () => {
    const user = await createUserByAdmin();

    try {
      await expect(getRespondentUserStatus(user.id)).resolves.toStrictEqual({
        contractVersion: 1,
        id: user.id,
        status: 'active',
      });

      await suspendUser(user.id, true);
      await expect(getRespondentUserStatus(user.id)).resolves.toStrictEqual({
        contractVersion: 1,
        id: user.id,
        status: 'suspended',
      });

      const verification = await verifyRespondentSession(user.id, {
        clientId: 'integration-client',
        sid: 'unknown-sid',
        maxInactivitySeconds: 90,
      });

      expect(verification).toMatchObject({
        contractVersion: 1,
        valid: false,
        reason: 'not_active',
        maxInactivitySeconds: 90,
      });
      expect(verification).not.toHaveProperty('sessionUid');
      expect(verification).not.toHaveProperty('sessions');
    } finally {
      await deleteUser(user.id);
    }
  });
});
