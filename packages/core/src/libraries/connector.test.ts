import { TemplateType } from '@logto/connector-kit';
import type { Connector } from '@logto/schemas';

import RequestError from '#src/errors/RequestError/index.js';
import { MockQueries } from '#src/test-utils/tenant.js';

const { jest } = import.meta;

const connectors: Connector[] = [
  {
    tenantId: 'fake_tenant',
    id: 'id',
    config: { foo: 'bar' },
    createdAt: 0,
    syncProfile: false,
    enableTokenStorage: false,
    connectorId: 'id',
    metadata: {},
  },
];

const { createConnectorLibrary } = await import('./connector.js');
const { getConnectorConfig } = createConnectorLibrary(
  new MockQueries({ connectors: { findAllConnectors: async () => connectors } }),
  { getClient: jest.fn() }
);

it('getConnectorConfig() should return right config', async () => {
  const config = await getConnectorConfig('id');
  expect(config).toMatchObject({ foo: 'bar' });
});

it('getConnectorConfig() should throw error if connector not found', async () => {
  await expect(getConnectorConfig('not-found')).rejects.toMatchError(
    new RequestError({ code: 'entity.not_found', id: 'not-found', status: 404 })
  );
});

describe('getI18nEmailTemplate', () => {
  const mockFindByLanguageTag = jest.fn();
  const mockFindDefault = jest.fn();

  const createLibrary = () =>
    createConnectorLibrary(
      new MockQueries({
        emailTemplates: {
          findByLanguageTagAndTemplateType: mockFindByLanguageTag,
        },
        signInExperiences: {
          findDefaultSignInExperience: mockFindDefault,
        },
      }),
      { getClient: jest.fn() }
    );

  beforeEach(() => {
    mockFindByLanguageTag.mockReset();
    mockFindDefault.mockReset();
    mockFindDefault.mockResolvedValue({
      languageInfo: { fallbackLanguage: 'en' },
    });
  });

  it('should return template by exact language tag match', async () => {
    mockFindByLanguageTag.mockResolvedValueOnce({ details: { subject: 'ka-GE template' } });
    const { getI18nEmailTemplate } = createLibrary();

    const result = await getI18nEmailTemplate(TemplateType.SignIn, 'ka-GE');
    expect(result).toEqual({ subject: 'ka-GE template' });
    expect(mockFindByLanguageTag).toHaveBeenCalledWith(TemplateType.SignIn, 'ka-GE');
    // Should not call fallback
    expect(mockFindByLanguageTag).toHaveBeenCalledTimes(1);
    expect(mockFindDefault).not.toHaveBeenCalled();
  });

  it('should fallback to parent language tag when exact match is not found', async () => {
    // First call (exact 'ka-GE') returns nothing
    mockFindByLanguageTag.mockResolvedValueOnce(null);
    // Second call (parent 'ka') returns the template
    mockFindByLanguageTag.mockResolvedValueOnce({ details: { subject: 'ka template' } });
    const { getI18nEmailTemplate } = createLibrary();

    const result = await getI18nEmailTemplate(TemplateType.SignIn, 'ka-GE');
    expect(result).toEqual({ subject: 'ka template' });
    expect(mockFindByLanguageTag).toHaveBeenNthCalledWith(1, TemplateType.SignIn, 'ka-GE');
    expect(mockFindByLanguageTag).toHaveBeenNthCalledWith(2, TemplateType.SignIn, 'ka');
    expect(mockFindByLanguageTag).toHaveBeenCalledTimes(2);
    expect(mockFindDefault).not.toHaveBeenCalled();
  });

  it('should not attempt parent fallback when language tag has no region subtag', async () => {
    mockFindByLanguageTag.mockResolvedValueOnce({ details: { subject: 'ka template' } });
    const { getI18nEmailTemplate } = createLibrary();

    const result = await getI18nEmailTemplate(TemplateType.SignIn, 'ka');
    expect(result).toEqual({ subject: 'ka template' });
    expect(mockFindByLanguageTag).toHaveBeenCalledTimes(1);
    expect(mockFindByLanguageTag).toHaveBeenCalledWith(TemplateType.SignIn, 'ka');
  });

  it('should handle language tags with underscore separators as parent fallback', async () => {
    mockFindByLanguageTag.mockResolvedValueOnce(null);
    mockFindByLanguageTag.mockResolvedValueOnce({ details: { subject: 'ka template' } });
    const { getI18nEmailTemplate } = createLibrary();

    const result = await getI18nEmailTemplate(TemplateType.SignIn, 'ka_GE');
    expect(result).toEqual({ subject: 'ka template' });
    expect(mockFindByLanguageTag).toHaveBeenNthCalledWith(1, TemplateType.SignIn, 'ka_GE');
    expect(mockFindByLanguageTag).toHaveBeenNthCalledWith(2, TemplateType.SignIn, 'ka');
    expect(mockFindByLanguageTag).toHaveBeenCalledTimes(2);
  });

  it('should fallback to sign-in-experience fallbackLanguage when no exact or parent match', async () => {
    // Exact 'ka-GE' not found
    mockFindByLanguageTag.mockResolvedValueOnce(null);
    // Parent 'ka' not found
    mockFindByLanguageTag.mockResolvedValueOnce(null);
    // Fallback language 'en' found
    mockFindByLanguageTag.mockResolvedValueOnce({ details: { subject: 'en fallback template' } });
    const { getI18nEmailTemplate } = createLibrary();

    const result = await getI18nEmailTemplate(TemplateType.SignIn, 'ka-GE');
    expect(result).toEqual({ subject: 'en fallback template' });
    expect(mockFindByLanguageTag).toHaveBeenNthCalledWith(1, TemplateType.SignIn, 'ka-GE');
    expect(mockFindByLanguageTag).toHaveBeenNthCalledWith(2, TemplateType.SignIn, 'ka');
    expect(mockFindByLanguageTag).toHaveBeenNthCalledWith(3, TemplateType.SignIn, 'en');
    expect(mockFindByLanguageTag).toHaveBeenCalledTimes(3);
  });

  it('should fallback to Generic template type with fallbackLanguage as final resort', async () => {
    // Exact not found, parent not found, fallback language not found
    mockFindByLanguageTag.mockResolvedValueOnce(null); // Exact 'ka-GE'
    mockFindByLanguageTag.mockResolvedValueOnce(null); // Parent 'ka'
    mockFindByLanguageTag.mockResolvedValueOnce(null); // Fallback lang 'en' with SignIn
    // Generic with fallback lang 'en' found
    mockFindByLanguageTag.mockResolvedValueOnce({ details: { subject: 'generic en template' } });
    const { getI18nEmailTemplate } = createLibrary();

    const result = await getI18nEmailTemplate(TemplateType.SignIn, 'ka-GE');
    expect(result).toEqual({ subject: 'generic en template' });
    expect(mockFindByLanguageTag).toHaveBeenNthCalledWith(1, TemplateType.SignIn, 'ka-GE');
    expect(mockFindByLanguageTag).toHaveBeenNthCalledWith(2, TemplateType.SignIn, 'ka');
    expect(mockFindByLanguageTag).toHaveBeenNthCalledWith(3, TemplateType.SignIn, 'en');
    expect(mockFindByLanguageTag).toHaveBeenNthCalledWith(4, TemplateType.Generic, 'en');
    expect(mockFindByLanguageTag).toHaveBeenCalledTimes(4);
  });

  it('should return undefined when no template found at any fallback level', async () => {
    mockFindByLanguageTag.mockResolvedValue(null);
    const { getI18nEmailTemplate } = createLibrary();

    const result = await getI18nEmailTemplate(TemplateType.SignIn, 'ka-GE');
    expect(result).toBeUndefined();
    expect(mockFindByLanguageTag).toHaveBeenCalledTimes(4);
  });

  it('should skip language tag lookups when languageTag is not provided', async () => {
    mockFindByLanguageTag.mockResolvedValueOnce({ details: { subject: 'en fallback template' } });
    const { getI18nEmailTemplate } = createLibrary();

    const result = await getI18nEmailTemplate(TemplateType.SignIn);
    expect(result).toEqual({ subject: 'en fallback template' });
    expect(mockFindByLanguageTag).toHaveBeenCalledTimes(1);
    expect(mockFindByLanguageTag).toHaveBeenCalledWith(TemplateType.SignIn, 'en');
  });

  it('should handle complex language tags like zh-Hans-CN', async () => {
    mockFindByLanguageTag.mockResolvedValueOnce(null); // Exact 'zh-Hans-CN'
    mockFindByLanguageTag.mockResolvedValueOnce({ details: { subject: 'zh template' } }); // Parent 'zh'
    const { getI18nEmailTemplate } = createLibrary();

    const result = await getI18nEmailTemplate(TemplateType.SignIn, 'zh-Hans-CN');
    expect(result).toEqual({ subject: 'zh template' });
    expect(mockFindByLanguageTag).toHaveBeenNthCalledWith(1, TemplateType.SignIn, 'zh-Hans-CN');
    expect(mockFindByLanguageTag).toHaveBeenNthCalledWith(2, TemplateType.SignIn, 'zh');
    expect(mockFindByLanguageTag).toHaveBeenCalledTimes(2);
  });

  it('should skip parent fallback for invalid language tags', async () => {
    // Empty string is falsy, so the languageTag block is skipped entirely.
    // Falsy values like '' and undefined go straight to fallback.
    mockFindByLanguageTag.mockResolvedValueOnce({ details: { subject: 'en fallback template' } });
    const { getI18nEmailTemplate } = createLibrary();

    const result = await getI18nEmailTemplate(TemplateType.SignIn, '');
    expect(result).toEqual({ subject: 'en fallback template' });
    expect(mockFindByLanguageTag).toHaveBeenNthCalledWith(1, TemplateType.SignIn, 'en');
    expect(mockFindByLanguageTag).toHaveBeenCalledTimes(1);
  });
});
