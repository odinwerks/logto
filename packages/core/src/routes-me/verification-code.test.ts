import { TemplateType } from '@logto/connector-kit';
import { createMockUtils, pickDefault } from '@logto/shared/esm';

import { mockUser } from '#src/__mocks__/index.js';
import type Queries from '#src/tenants/Queries.js';
import { MockTenant, type Partial2 } from '#src/test-utils/tenant.js';
import { createRequester } from '#src/utils/test-utils.js';

const { jest } = import.meta;
const { mockEsmWithActual } = createMockUtils(jest);

const mockPasscode = { id: 'passcode-id', code: '123456', email: 'test@abc.com' };

const passcodeLibraries = await mockEsmWithActual('#src/libraries/passcode.js', () => ({
  createPasscode: jest.fn().mockResolvedValue(mockPasscode),
  sendPasscode: jest.fn(),
  verifyPasscode: jest.fn(),
}));

const { createPasscode, sendPasscode, verifyPasscode } = passcodeLibraries;

const mockedQueries = {
  users: {
    findUserById: jest.fn(async () => mockUser),
  },
} satisfies Partial2<Queries>;

const mockedLibraries = {
  verificationStatuses: {
    createVerificationStatus: jest.fn(),
  },
};

const codeType = TemplateType.Generic;

const verificationCodeRoutes = await pickDefault(import('./verification-code.js'));

describe('me verification code routes', () => {
  const tenantContext = new MockTenant(undefined, mockedQueries, undefined, {
    passcodes: passcodeLibraries,
    ...mockedLibraries,
  });
  const meRequest = createRequester({
    authedRoutes: [
      (router) => {
        router.use(async (ctx, next) => {
          ctx.auth = {
            ...ctx.auth,
            id: mockUser.id,
          };

          return next();
        });
      },
      verificationCodeRoutes as never,
    ],
    tenantContext,
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /verification-codes', () => {
    const email = 'test@abc.com';

    it('should create and send passcode with email', async () => {
      const response = await meRequest.post('/verification-codes').send({ email });
      expect(response.status).toEqual(204);
      expect(createPasscode).toHaveBeenCalledWith(undefined, codeType, { email });
      expect(sendPasscode).toHaveBeenCalled();
    });

    it('should pass body locale to sendPasscode when provided', async () => {
      const response = await meRequest.post('/verification-codes').send({ email, locale: 'ka' });
      expect(response.status).toEqual(204);
      // Locale should be stripped from body before createPasscode
      expect(createPasscode).toHaveBeenCalledWith(undefined, codeType, { email });
      expect(sendPasscode).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ locale: 'ka' })
      );
    });

    it('should normalize region-tagged locale to base language tag', async () => {
      const response = await meRequest.post('/verification-codes').send({ email, locale: 'ka-GE' });
      expect(response.status).toEqual(204);
      // Locale should be stripped from body before createPasscode
      expect(createPasscode).toHaveBeenCalledWith(undefined, codeType, { email });
      expect(sendPasscode).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ locale: 'ka' })
      );
    });
  });

  describe('POST /verification-codes/verify', () => {
    it('should verify passcode successfully', async () => {
      const verificationCode = '123456';
      const response = await meRequest
        .post('/verification-codes/verify')
        .send({ email: 'test@abc.com', verificationCode });
      expect(response.status).toEqual(204);
      expect(verifyPasscode).toHaveBeenCalled();
    });
  });
});
