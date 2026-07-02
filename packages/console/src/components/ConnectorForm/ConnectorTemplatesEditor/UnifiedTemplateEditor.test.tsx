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

const deliveriesItem: ConnectorConfigFormItem = {
  key: 'deliveries',
  label: 'Deliveries',
  type: ConnectorConfigFormItemType.Json,
  required: false,
  defaultValue: {},
};

const buildDefaultValues = (): Record<string, unknown> => ({
  syncProfile: SyncProfileMode.OnlyAtRegister,
  jsonConfig: '{}',
  formConfig: {
    deliveries: JSON.stringify(
      {
        Generic: {
          subject: 'Logto generic template {{code}}',
          html: 'Your Logto generic verification code is {{code}}.',
        },
      },
      null,
      2
    ),
    templates: JSON.stringify([], null, 2),
    translations: '{}',
    templateEditorMode: JSON.stringify('unified'),
  },
  rawConfig: {},
  enableTokenStorage: false,
});

function CommittedDeliveriesProbe() {
  const value: unknown = useWatch({ name: 'formConfig.deliveries' });

  return <div data-testid="committed-deliveries">{typeof value === 'string' ? value : ''}</div>;
}

/**
 * Renders `formState.isDirty` into the DOM. Reading `isDirty` inside a rendered component
 * subscribes the probe to dirty updates, so it re-renders (and mirrors the value) whenever isDirty
 * flips — letting tests assert the save-footer driver without capturing form methods imperatively.
 */
function DirtyProbe() {
  const { formState } = useFormContext<ConnectorFormType>();

  return <div data-testid="dirty-probe">{formState.isDirty ? 'true' : 'false'}</div>;
}

/**
 * Default values for a connector that was saved in Unified mode: the unified source fields are
 * present AND the compiled `deliveries`/`translations` mirror only stored a subset (just
 * `Generic`). On load, recompiling the unified source expands to every delivery type, so the
 * mirror differs structurally from the recompile — a spurious-dirty trap the write-back must not
 * fall into.
 */
const buildSavedUnifiedDefaultValues = (): Record<string, unknown> => {
  const translations = { en: { code: 'english' } };

  return {
    syncProfile: SyncProfileMode.OnlyAtRegister,
    jsonConfig: '{}',
    formConfig: {
      // Stale mirror: only `Generic`, even though the unified source compiles to all types.
      deliveries: JSON.stringify(
        { Generic: { html: 'Hello {{code}}', subject: 'Subject {{code}}' } },
        null,
        2
      ),
      templates: JSON.stringify([], null, 2),
      translations: JSON.stringify(translations, null, 2),
      templateEditorMode: JSON.stringify('unified'),
      unifiedTemplate: JSON.stringify({ content: 'Hello {{code}}' }, null, 2),
      unifiedSubjects: JSON.stringify({ Generic: 'Subject {{code}}' }, null, 2),
      unifiedTranslations: JSON.stringify(translations, null, 2),
      variables: JSON.stringify({}, null, 2),
    },
    rawConfig: {},
    enableTokenStorage: false,
  };
};

const renderEditor = () => {
  const defaultValues = buildDefaultValues();

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
              formItem={deliveriesItem}
              connectorType={ConnectorType.Email}
              connectorFactoryId="mailgun-email"
            />
          </form>
          <CommittedDeliveriesProbe />
        </MemoryRouter>
      </FormProvider>
    );
  }

  const utils = render(<Harness />);

  return {
    ...utils,
    getTabByText: (text: string) =>
      Array.from(document.querySelectorAll('[role="tab"]')).find((tab) =>
        tab.textContent?.includes(text)
      ),
    getDeliveries: () => {
      return document.querySelector('[data-testid="committed-deliveries"]')?.textContent ?? '';
    },
  };
};

describe('<UnifiedTemplateEditor />', () => {
  it('does not write malformed <If> tags into deliveries while a parse error is present', async () => {
    jest.useFakeTimers();

    const { getTabByText, getDeliveries, container } = renderEditor();

    await waitFor(() => {
      expect(getTabByText('Template')).not.toBeUndefined();
    });

    const initialDeliveries = getDeliveries();
    const input = container.querySelector('textarea');
    expect(input).not.toBeNull();

    act(() => {
      fireEvent.change(input!, {
        target: { value: '<If type="SignIn"><If type="Register">inner</If></If>' },
      });
    });

    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(getDeliveries()).toBe(initialDeliveries);

    jest.useRealTimers();
  });

  it('writes an empty Generic row when the unified content is cleared after editing', async () => {
    jest.useFakeTimers();

    const { getTabByText, getDeliveries, container } = renderEditor();

    await waitFor(() => {
      expect(getTabByText('Template')).not.toBeUndefined();
    });

    const input = container.querySelector('textarea');
    expect(input).not.toBeNull();

    act(() => {
      fireEvent.change(input!, { target: { value: 'Hello {{code}}' } });
    });

    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(getDeliveries()).toContain('Hello {{code}}');

    act(() => {
      fireEvent.change(input!, { target: { value: '' } });
    });

    act(() => {
      jest.advanceTimersByTime(300);
    });

    // Auto-seeding preserves the classic subject in `unifiedSubjects`, so clearing the content
    // leaves an empty `html` while the seeded subject remains.
    expect(JSON.parse(getDeliveries())).toEqual({
      Generic: { html: '', subject: 'Logto generic template {{code}}' },
    });

    jest.useRealTimers();
  });

  // --- save-footer / isDirty determinism -------------------------------------
  //
  // The save footer is driven by `formState.isDirty`. The unified editor must NOT spuriously dirty
  // the form when loading an already-saved connector (the compiled mirror may legitimately differ
  // from a stale saved `deliveries`, e.g. the compiler expands a single unified template into all
  // delivery types while the saved mirror only stored a subset). It MUST reliably dirty the form
  // when the user edits the unified source (template / variables / localizations / subjects).

  /**
   * Renders the unified editor with a live `formState.isDirty` probe exposed via the returned
   * `getIsDirty` getter. Mirrors `renderEditor` but adds the {@link DirtyProbe} so tests can assert
   * the save-footer driver without capturing form methods imperatively across renders.
   */
  const renderEditorWithDirtyProbe = (
    defaultValues: Record<string, unknown>
  ): {
    container: HTMLElement;
    getIsDirty: () => boolean;
    getTabByText: (text: string) => Element | undefined;
  } => {
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
                formItem={deliveriesItem}
                connectorType={ConnectorType.Email}
                connectorFactoryId="mailgun-email"
              />
            </form>
          </MemoryRouter>
          <DirtyProbe />
        </FormProvider>
      );
    }

    const { container } = render(<Harness />);

    return {
      container,
      getIsDirty: () =>
        document.querySelector('[data-testid="dirty-probe"]')?.textContent === 'true',
      getTabByText: (text: string) =>
        Array.from(document.querySelectorAll('[role="tab"]')).find((tab) =>
          tab.textContent?.includes(text)
        ),
    };
  };

  it('does not spuriously dirty the form when loading a saved unified connector', async () => {
    jest.useFakeTimers();

    const { getIsDirty, getTabByText } = renderEditorWithDirtyProbe(
      buildSavedUnifiedDefaultValues()
    );

    await waitFor(() => {
      expect(getTabByText('Template')).not.toBeUndefined();
    });

    // Allow the seeding effect (setTimeout 0) and any debounced write-back to run.
    act(() => {
      jest.advanceTimersByTime(500);
    });

    // The mirror is recompiled and resynced (shouldDirty: false) without flipping isDirty.
    expect(getIsDirty()).toBe(false);

    jest.useRealTimers();
  });

  it('flips isDirty deterministically after editing the unified template content', async () => {
    jest.useFakeTimers();

    const { getIsDirty, getTabByText, container } = renderEditorWithDirtyProbe(
      buildSavedUnifiedDefaultValues()
    );

    await waitFor(() => {
      expect(getTabByText('Template')).not.toBeUndefined();
    });

    act(() => {
      jest.advanceTimersByTime(500);
    });

    // Baseline: not dirty on load.
    expect(getIsDirty()).toBe(false);

    const input = container.querySelector('textarea');
    expect(input).not.toBeNull();

    act(() => {
      fireEvent.change(input!, { target: { value: 'Hello {{code}} edited' } });
    });

    // Flush the debounced mirror write-back.
    act(() => {
      jest.advanceTimersByTime(500);
    });

    // The source-field edit (onTemplateChange) flips isDirty; the mirror write-back does not
    // un-dirty it.
    expect(getIsDirty()).toBe(true);

    jest.useRealTimers();
  });

  it('flips isDirty deterministically after editing unified localizations', async () => {
    jest.useFakeTimers();

    const { getIsDirty, getTabByText, container } = renderEditorWithDirtyProbe(
      buildSavedUnifiedDefaultValues()
    );

    await waitFor(() => {
      expect(getTabByText('Template')).not.toBeUndefined();
    });

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(getIsDirty()).toBe(false);

    // Switch to the Localizations tab and edit the selected language's dictionary.
    act(() => {
      fireEvent.click(getTabByText('Localizations')!);
    });

    // The unified dict editor renders a key/value table; the value cell is the 2nd column and uses
    // a `TextInput` (`<input>`), not a textarea.
    const valueCell = container.querySelector<HTMLInputElement>(
      'table tbody tr td:nth-child(2) input'
    );
    expect(valueCell).not.toBeNull();

    act(() => {
      fireEvent.change(valueCell!, { target: { value: 'english-edited' } });
    });

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(getIsDirty()).toBe(true);

    jest.useRealTimers();
  });
});
