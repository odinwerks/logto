import {
  ConnectorConfigFormItemType,
  ConnectorType,
  type ConnectorConfigFormItem,
} from '@logto/connector-kit';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { FormProvider, useForm, useFormContext, useWatch } from 'react-hook-form';
import Modal from 'react-modal';
import { MemoryRouter } from 'react-router-dom';

import ConnectorTemplatesEditor from '@/components/ConnectorForm/ConnectorTemplatesEditor';
import type { ConnectorFormType } from '@/types/connector';
import { SyncProfileMode } from '@/types/connector';

// The component tree pulls in `@/consts/env` (via icons/DS components), which reads Vite's
// `import.meta.env`. Jest does not define that, so mock the env module.
jest.mock('@/consts/env', () => ({
  isProduction: false,
  isCloud: false,
  isProtectedAppLocalDevEnabled: false,
  isProtectedAppEnabled: false,
  adminEndpoint: undefined,
  isDevFeaturesEnabled: true,
  consoleEmbeddedPricingUrl: undefined,
  inkeepApiKey: undefined,
  postHogKey: undefined,
  postHogHost: undefined,
  postHogUiHost: undefined,
  ossSurveyEndpoint: undefined,
}));

jest.mock('@/hooks/use-api', () => {
  return () => ({
    get: jest.fn(),
    post: jest.fn(() => ({
      json: jest.fn().mockResolvedValue({}),
    })),
    put: jest.fn(),
    delete: jest.fn(),
  });
});

// `CodeEditor` pulls in `react-syntax-highlighter` (ESM) that Jest cannot transform by default.
// Stub it as a `<textarea>` so JSON-mode (and the unified Template tab) stays drivable.
jest.mock('@/ds-components/CodeEditor', () => ({
  __esModule: true,
  default: ({ value, onChange }: { value?: string; onChange?: (value: string) => void }) => (
    <textarea
      data-testid="json-editor"
      value={value}
      onChange={(event) => {
        onChange?.(event.currentTarget.value);
      }}
    />
  ),
}));

i18next.addResourceBundle('en', 'translation', {
  admin_console: {
    general: {
      type_to_search: 'Type to search',
      confirm: 'Confirm',
      cancel: 'Cancel',
    },
    connector_details: {
      template_editor: {
        template_translations_available: 'Template translations available',
        delivery_templates: 'Delivery templates',
        form_mode: 'Form',
        json_mode: 'JSON',
        key: 'Key',
        value: 'Value',
        add_localizations: 'Add localizations',
        add_key: 'Add key',
        delete_language: 'Delete language',
        content_placeholder: 'Use {{code}}.',
      },
      unified_editor: {
        mode_classic: 'Classic per-type',
        mode_unified: 'Unified',
        tab_template: 'Template',
        tab_variables: 'Variables',
        tab_localizations: 'Localizations',
        add_variable: 'Add variable',
        variable_key_prompt: 'Enter variable key',
        delete_variable: 'Delete variable',
        no_variables: 'No variables yet.',
        no_languages: 'No languages yet.',
        parse_error: 'The template has invalid <If> blocks.',
        preview: 'Preview',
        preview_as_type: 'Preview as type',
        preview_language: 'Preview language',
      },
    },
  },
});

Modal.setAppElement(document.body);

// Mailgun email uses a `deliveries` form item (the row the unified editor compiles into).
const deliveriesItem: ConnectorConfigFormItem = {
  key: 'deliveries',
  label: 'Deliveries',
  type: ConnectorConfigFormItemType.Json,
  required: false,
  defaultValue: {},
};

const templatesItem: ConnectorConfigFormItem = {
  key: 'templates',
  label: 'Templates',
  type: ConnectorConfigFormItemType.Json,
  required: false,
  defaultValue: [],
};

type RenderOptions = {
  readonly deliveries?: unknown;
  readonly templates?: unknown;
  readonly formItem?: ConnectorConfigFormItem;
  readonly connectorFactoryId?: string;
  readonly templateEditorMode?: string;
  readonly unifiedTemplate?: unknown;
  readonly unifiedTranslations?: unknown;
};

const buildDefaultValues = (overrides?: {
  deliveries?: unknown;
  templates?: unknown;
  templateEditorMode?: string;
  unifiedTemplate?: unknown;
  unifiedTranslations?: unknown;
}): Record<string, unknown> => ({
  syncProfile: SyncProfileMode.OnlyAtRegister,
  jsonConfig: '{}',
  formConfig: {
    deliveries: JSON.stringify(
      overrides?.deliveries ?? {
        Generic: {
          subject: 'Logto generic template {{code}}',
          html: 'Your Logto generic verification code is {{code}}.',
        },
      },
      null,
      2
    ),
    templates: JSON.stringify(
      overrides?.templates ?? [
        {
          usageType: 'Generic',
          subject: 'Logto generic template {{code}}',
          html: 'Your Logto generic verification code is {{code}}.',
        },
      ],
      null,
      2
    ),
    translations: '{}',
    templateEditorMode: overrides?.templateEditorMode,
    unifiedTemplate: overrides?.unifiedTemplate ?? '{}',
    unifiedTranslations: overrides?.unifiedTranslations ?? '{}',
    unifiedSubjects: '{}',
    variables: '{}',
  },
  rawConfig: {},
  enableTokenStorage: false,
});

const renderEditor = ({
  deliveries,
  templates,
  formItem = deliveriesItem,
  connectorFactoryId,
  templateEditorMode,
  unifiedTemplate,
  unifiedTranslations,
}: RenderOptions = {}) => {
  const defaultValues = buildDefaultValues({
    deliveries,
    templates,
    templateEditorMode,
    unifiedTemplate,
    unifiedTranslations,
  });

  function Harness() {
    const methods = useForm<ConnectorFormType>({ defaultValues });

    return (
      <FormProvider {...methods}>
        <MemoryRouter>
          <form
            onSubmit={methods.handleSubmit(() => {
              /* Noop */
            })}
          >
            <ConnectorTemplatesEditor
              formItem={formItem}
              connectorType={ConnectorType.Email}
              connectorFactoryId={connectorFactoryId}
            />
          </form>
        </MemoryRouter>
        <CommittedUnifiedProbe />
        <CommittedDeliveriesProbe />
        <CommittedUnifiedTemplateProbe />
        <CommittedVariablesProbe />
        <CommittedUnifiedTranslationsProbe />
        <CommittedTranslationsProbe />
        <DirtyProbe />
      </FormProvider>
    );
  }

  const utils = render(<Harness />);

  return {
    ...utils,
    getButtonByText: (text: string) =>
      Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === text
      ),
    getTabByText: (text: string) =>
      Array.from(document.querySelectorAll('[role="tab"]')).find((tab) =>
        tab.textContent?.includes(text)
      ),
    getDeliveries: () => {
      return document.querySelector('[data-testid="committed-deliveries"]')?.textContent ?? '';
    },
    getUnifiedTemplate: () => {
      return (
        document.querySelector('[data-testid="committed-unified-template"]')?.textContent ?? ''
      );
    },
    getVariables: () => {
      return document.querySelector('[data-testid="committed-variables"]')?.textContent ?? '';
    },
    getUnifiedTranslations: () => {
      return (
        document.querySelector('[data-testid="committed-unified-translations"]')?.textContent ?? ''
      );
    },
    getTranslations: () => {
      return document.querySelector('[data-testid="committed-translations"]')?.textContent ?? '';
    },
    getMode: () => {
      return document.querySelector('[data-testid="committed-mode"]')?.textContent ?? '';
    },
    getIsDirty: () => document.querySelector('[data-testid="dirty-probe"]')?.textContent === 'true',
  };
};

function CommittedUnifiedTemplateProbe() {
  const value: unknown = useWatch({ name: 'formConfig.unifiedTemplate' });
  return (
    <div data-testid="committed-unified-template">{typeof value === 'string' ? value : ''}</div>
  );
}

function CommittedVariablesProbe() {
  const value: unknown = useWatch({ name: 'formConfig.variables' });
  return <div data-testid="committed-variables">{typeof value === 'string' ? value : ''}</div>;
}

function CommittedUnifiedTranslationsProbe() {
  const value: unknown = useWatch({ name: 'formConfig.unifiedTranslations' });
  return (
    <div data-testid="committed-unified-translations">{typeof value === 'string' ? value : ''}</div>
  );
}

function CommittedTranslationsProbe() {
  const value: unknown = useWatch({ name: 'formConfig.translations' });
  return <div data-testid="committed-translations">{typeof value === 'string' ? value : ''}</div>;
}

function CommittedUnifiedProbe() {
  const value: unknown = useWatch({ name: 'formConfig.templateEditorMode' });

  return <div data-testid="committed-mode">{typeof value === 'string' ? value : ''}</div>;
}

function CommittedDeliveriesProbe() {
  const value: unknown = useWatch({ name: 'formConfig.deliveries' });

  return <div data-testid="committed-deliveries">{typeof value === 'string' ? value : ''}</div>;
}

function DirtyProbe() {
  const { formState } = useFormContext<ConnectorFormType>();

  return <div data-testid="dirty-probe">{formState.isDirty ? 'true' : 'false'}</div>;
}

describe('<ConnectorTemplatesEditor /> — Unified editor gate', () => {
  it('renders the classic editor when the connector factory id is not in the allowlist', () => {
    const { getButtonByText, getTabByText } = renderEditor({ connectorFactoryId: 'aliyun-dm' });

    // Classic editor: delivery-templates section header is present and unified sub-tabs are absent.
    expect(getButtonByText('Classic per-type')).toBeUndefined();
    expect(getButtonByText('Unified')).toBeUndefined();
    expect(getTabByText('Variables')).toBeUndefined();
  });

  it('renders the classic editor for the ubill-sms connector factory id', () => {
    const { getButtonByText, getTabByText } = renderEditor({ connectorFactoryId: 'ubill-sms' });

    expect(getButtonByText('Classic per-type')).toBeUndefined();
    expect(getButtonByText('Unified')).toBeUndefined();
    expect(getTabByText('Variables')).toBeUndefined();
  });

  it('does NOT show a Classic/Unified toggle for the Mailgun email connector', () => {
    const { getButtonByText, getTabByText } = renderEditor({ connectorFactoryId: 'mailgun-email' });

    expect(getButtonByText('Classic per-type')).toBeUndefined();
    expect(getButtonByText('Unified')).toBeUndefined();
    // Unified editor sub-tabs are visible immediately.
    expect(getTabByText('Template')).not.toBeUndefined();
    expect(getTabByText('Variables')).not.toBeUndefined();
    expect(getTabByText('Localizations')).not.toBeUndefined();
  });

  it('auto-seeds the unified editor from classic deliveries on mount for Mailgun', async () => {
    const { getTabByText, getUnifiedTemplate } = renderEditor({
      connectorFactoryId: 'mailgun-email',
    });

    // Unified sub-tabs mount immediately.
    await waitFor(() => {
      expect(getTabByText('Template')).not.toBeUndefined();
      expect(getTabByText('Variables')).not.toBeUndefined();
      expect(getTabByText('Localizations')).not.toBeUndefined();
    });

    // The reverse-compile seed writes a unifiedTemplate (with the Generic html body as `content`).
    await waitFor(() => {
      expect(getUnifiedTemplate()).toContain('Your Logto generic verification code is {{code}}.');
    });
  });

  it('auto-seeds the unified editor from classic standard array templates on mount for Mailgun', async () => {
    const { getTabByText, getUnifiedTemplate } = renderEditor({
      connectorFactoryId: 'mailgun-email',
      formItem: templatesItem,
      templates: [
        {
          usageType: 'Generic',
          subject: 'Standard template subject',
          html: 'Standard template HTML',
        },
      ],
    });

    await waitFor(() => {
      expect(getTabByText('Template')).not.toBeUndefined();
      expect(getTabByText('Variables')).not.toBeUndefined();
      expect(getTabByText('Localizations')).not.toBeUndefined();
    });

    await waitFor(() => {
      expect(getUnifiedTemplate()).toContain('Standard template HTML');
    });
  });

  it('does not overwrite existing unified data when auto-seeding', () => {
    const { getUnifiedTemplate } = renderEditor({
      connectorFactoryId: 'mailgun-email',
      unifiedTemplate: JSON.stringify({ content: 'Existing unified body' }),
    });

    expect(getUnifiedTemplate()).toBe('{"content":"Existing unified body"}');
  });

  it('does not dirty the form after seeding unified fields from classic data', () => {
    jest.useFakeTimers();

    const { getIsDirty } = renderEditor({ connectorFactoryId: 'mailgun-email' });

    // Advance timers past the seeding setTimeout(0) and any debounced write-back.
    act(() => {
      jest.advanceTimersByTime(500);
    });

    // Seeding is a re-derivation from already-persisted classic data, not a user edit.
    expect(getIsDirty()).toBe(false);

    jest.useRealTimers();
  });

  it('persists templateEditorMode as unified for Mailgun for backward compatibility', async () => {
    const { getMode } = renderEditor({
      connectorFactoryId: 'mailgun-email',
      templateEditorMode: JSON.stringify('classic'),
    });

    await waitFor(() => {
      expect(getMode()).toBe('"unified"');
    });
  });

  it('debounces the compiled write-back by 250ms and flushes immediately on submit', async () => {
    jest.useFakeTimers();

    const { getTabByText, getDeliveries, container } = renderEditor({
      connectorFactoryId: 'mailgun-email',
      templateEditorMode: JSON.stringify('unified'),
    });

    // Make sure we are in unified mode
    await waitFor(() => {
      expect(getTabByText('Template')).not.toBeUndefined();
    });

    const initialDeliveries = getDeliveries();
    expect(initialDeliveries).toContain('Logto generic template');

    // Find the text version textarea field and edit it.
    const input = container.querySelector('textarea');
    expect(input).not.toBeNull();

    act(() => {
      fireEvent.change(input!, { target: { value: 'A completely new text body' } });
    });

    // Flush any initial microtasks and effect scheduling
    act(() => {
      jest.advanceTimersByTime(0);
    });

    // The deliveries mirror field should NOT have updated immediately due to debounce.
    expect(getDeliveries()).toBe(initialDeliveries);

    // If we advance time by 100ms, it still should not have updated.
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(getDeliveries()).toBe(initialDeliveries);

    // If we advance time by another 150ms (total 250ms), it should update!
    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(getDeliveries()).not.toBe(initialDeliveries);
    expect(getDeliveries()).toContain('A completely new text body');

    // Now test that submitting flushes immediately
    act(() => {
      fireEvent.change(input!, { target: { value: 'Yet another text edit' } });
    });

    // Flush hook-form update microtasks so it schedules the new timer
    act(() => {
      jest.advanceTimersByTime(0);
    });

    expect(getDeliveries()).not.toContain('Yet another text edit');

    // Simulate form submission
    const form = container.querySelector('form');
    expect(form).not.toBeNull();

    act(() => {
      fireEvent.submit(form!);
    });

    // It should have flushed and updated immediately without any time advancing!
    expect(getDeliveries()).toContain('Yet another text edit');

    jest.useRealTimers();
  });
});
