/* eslint-disable max-lines */
import {
  ConnectorConfigFormItemType,
  ConnectorType,
  type ConnectorConfigFormItem,
} from '@logto/connector-kit';
import { fireEvent, render, waitFor } from '@testing-library/react';
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
// Upgrade the stub to a controllable `<textarea>` so JSON-mode tests can drive `value`/`onChange`
// and assert the `error` prop via `data-error`.
jest.mock('@/ds-components/CodeEditor', () => ({
  __esModule: true,
  default: ({
    value,
    onChange,
    error,
  }: {
    value?: string;
    onChange?: (value: string) => void;
    error?: string | boolean;
  }) => (
    <textarea
      data-testid="json-editor"
      value={value}
      data-error={error === undefined ? undefined : String(error)}
      onChange={(event) => {
        onChange?.(event.currentTarget.value);
      }}
    />
  ),
}));

// The shared `jest.setup.ts` only seeds `general.add`. Add the keys this editor renders so labels
// (buttons, tabs, the dirty-confirm) are stable strings rather than raw i18n keys.
i18next.addResourceBundle('en', 'translation', {
  admin_console: {
    general: {
      cancel: 'Cancel',
      type_to_search: 'Type to search',
      leave_page: 'Leave page',
      stay_on_page: 'Stay on page',
      unsaved_changes_warning: 'You have unsaved changes.',
    },
    connector_details: {
      template_editor: {
        add_localizations: 'Add localizations',
        apply: 'Apply',
        edit_translations: 'Edit translations',
        form_mode: 'Form',
        json_mode: 'JSON',
        key: 'Key',
        value: 'Value',
        no_translation_keys: 'No translation keys yet.',
        template_translations_available: 'Template translations available',
        delivery_templates: 'Delivery templates',
        delete_language: 'Delete language',
        invalid_json_format: 'The JSON is not valid.',
        json_must_be_object: 'Must be a JSON object.',
        json_values_must_be_strings: 'Values must be strings.',
        translations_for_language: 'Translations for {{language}}',
        json_merge_hint: 'Paste JSON.',
      },
    },
  },
});

// React-modal needs an app element to attach the portal and manage aria-hide.
Modal.setAppElement(document.body);

// --- helpers -------------------------------------------------------------

const templatesItem: ConnectorConfigFormItem = {
  key: 'templates',
  label: 'Templates',
  type: ConnectorConfigFormItemType.Json,
  required: false,
  defaultValue: [{ usageType: 'SignIn', content: 'Your code is {{code}}. {{t.code}}' }],
};

const buildDefaultValues = (overrides?: {
  templates?: unknown;
  translations?: unknown;
}): Record<string, unknown> => ({
  syncProfile: SyncProfileMode.OnlyAtRegister,
  jsonConfig: '{}',
  formConfig: {
    templates: JSON.stringify(
      overrides?.templates ?? [
        { usageType: 'SignIn', content: 'Your code is {{code}}. {{t.code}}' },
      ],
      null,
      2
    ),
    translations: JSON.stringify(overrides?.translations ?? {}),
  },
  rawConfig: {},
  enableTokenStorage: false,
});

type RenderOptions = {
  templates?: unknown;
  translations?: unknown;
  formItem?: ConnectorConfigFormItem;
  connectorType?: ConnectorType;
};

// A tiny subscriber rendered inside the form provider that mirrors the committed
// `formConfig.translations` field into the DOM. This lets tests read the committed state (what the
// modal wrote back on Apply) without capturing the form methods imperatively (which the project's
// functional-style lint rules forbid: no `let`/reassignment).
function CommittedTranslationsProbe() {
  // `useWatch` returns `any`; escape into `unknown` (a safe sink) rather than assigning `any`
  // directly, then narrow with `typeof` before rendering.
  const value: unknown = useWatch({ name: 'formConfig.translations' });

  return <div data-testid="committed-translations">{typeof value === 'string' ? value : ''}</div>;
}

// Reads the committed `formConfig.translations` (the JSON string the host wrote back via
// `setValue`/Apply) from the {@link CommittedTranslationsProbe} mirror. Module-scoped because it
// only reads the DOM (no closure state).
const getTranslations = (): Record<string, Record<string, string>> => {
  const raw = document.querySelector('[data-testid="committed-translations"]')?.textContent ?? '';

  return raw.trim().length > 0 ? (JSON.parse(raw) as Record<string, Record<string, string>>) : {};
};

// Module-scoped DOM helpers used by the save-footer / isDirty tests (they only read `document`).
const getIsDirtyFromProbe = () =>
  document.querySelector('[data-testid="dirty-probe"]')?.textContent === 'true';
const getModalApply = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="translation-modal-apply"]');
const getModalGridCells = () =>
  Array.from(document.querySelectorAll<HTMLTextAreaElement>('table textarea'));

const renderEditor = ({ templates, translations, formItem, connectorType }: RenderOptions = {}) => {
  const defaultValues = buildDefaultValues({ templates, translations });

  function Harness() {
    const methods = useForm<ConnectorFormType>({ defaultValues });

    return (
      <FormProvider {...methods}>
        {/* The translation modal renders `TabNav`/`TabNavItem`, whose `useTenantPathname` hook
            depends on react-router's `useLocation`/`useNavigate`. Wrap in a `MemoryRouter` so the
            modal renders without a real routing context. */}
        <MemoryRouter>
          <ConnectorTemplatesEditor
            formItem={formItem ?? templatesItem}
            connectorType={connectorType ?? ConnectorType.Sms}
          />
        </MemoryRouter>
        <CommittedTranslationsProbe />
      </FormProvider>
    );
  }

  const utils = render(<Harness />);

  return {
    ...utils,
    getTranslations,
    // Inline language pills (one per configured language).
    getLanguageItems: () => document.querySelectorAll('.languageItem'),
    // Per-pill delete (trash) buttons.
    getDeleteButtons: () => document.querySelectorAll<HTMLButtonElement>('.deleteButton'),
    // "Add localizations" trigger + popover (no Apply button; clicking a language adds it).
    getAddTrigger: () =>
      document.querySelector<HTMLButtonElement>('[data-testid="add-localizations-trigger"]'),
    getPopoverApply: () =>
      document.querySelector<HTMLButtonElement>('[data-testid="add-localizations-apply"]'),
    // Popover language option items (rendered with `role="tab"`).
    getPopoverOptions: () => document.querySelectorAll<HTMLElement>('[role="tab"]'),
    // The translation editor modal's footer Apply / Cancel.
    getModalApply: () =>
      document.querySelector<HTMLButtonElement>('[data-testid="translation-modal-apply"]'),
    getModalCancel: () =>
      document.querySelector<HTMLButtonElement>('[data-testid="translation-modal-cancel"]'),
    // The scrollable body div inside the ModalLayout (carries the `scrollableBody` class from the
    // CSS module; with `identity-obj-proxy` the class name appears verbatim in the DOM).
    getModalScrollableBody: () => document.querySelector('.scrollableBody'),
    // The mocked CodeEditor textarea (JSON mode).
    getJsonEditor: () => document.querySelector<HTMLTextAreaElement>('[data-testid="json-editor"]'),
    // The Form grid value editor cells.
    getGridCells: () =>
      Array.from(document.querySelectorAll<HTMLTextAreaElement>('table textarea')),
    // Find a `role="tab"` element anywhere in the DOM (language pills + modal Form/JSON tabs) by
    // its text content, so the index does not depend on how many language pills are present.
    getTabByText: (text: string) =>
      Array.from(document.querySelectorAll('[role="tab"]')).find((tab) =>
        tab.textContent?.includes(text)
      ),
    // Find a button anywhere in the DOM by its trimmed text content (confirm-modal actions, …).
    getButtonByText: (text: string) =>
      Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === text
      ),
  };
};

// --- tests ---------------------------------------------------------------

describe('<ConnectorTemplatesEditor />', () => {
  it('shows the "Add localizations" button and no language pills in the empty state', () => {
    const { getAddTrigger, getLanguageItems, getGridCells } = renderEditor();

    expect(getAddTrigger()).not.toBeNull();
    expect(getLanguageItems()).toHaveLength(0);
    // No inline translation grid (it is now inside the modal, which is closed).
    expect(getGridCells()).toHaveLength(0);
  });

  it('opens the popover, adds a language immediately on click (no Apply button), and opens the modal', async () => {
    const { getAddTrigger, getPopoverOptions, getPopoverApply, getLanguageItems, getModalApply } =
      renderEditor();

    // Open the "Add localizations" popover.
    fireEvent.click(getAddTrigger()!);

    // The popover lists every available language as a `role="tab"` item.
    await waitFor(() => {
      expect(getPopoverOptions().length).toBeGreaterThan(0);
    });

    // The popover has no Apply button (clicking a language adds it immediately).
    expect(getPopoverApply()).toBeNull();

    // Clicking the first available language adds it and opens the translation modal directly
    // (no separate Apply click required).
    fireEvent.click(getPopoverOptions()[0]!);

    // The language is added (a pill appears) and the translation modal opens (its Apply button is
    // mounted in the modal portal).
    await waitFor(() => {
      expect(getLanguageItems()).toHaveLength(1);
      expect(getModalApply()).not.toBeNull();
    });
  });

  it('renders a fixed header and footer with an internally scrollable body in the modal', async () => {
    const { getLanguageItems, getModalApply, getModalCancel, getModalScrollableBody } =
      renderEditor({ translations: { en: { code: 'english' } } });

    fireEvent.click(getLanguageItems()[0]!);

    await waitFor(() => {
      expect(getModalApply()).not.toBeNull();
    });

    // The modal exposes a scrollable body element (header/footer stay fixed, body scrolls).
    const scrollableBody = getModalScrollableBody();
    expect(scrollableBody).not.toBeNull();

    // The header (Apply/Cancel buttons live in the footer) and footer are siblings of the
    // scrollable body inside the Card container — i.e. they share a parent.
    const card = scrollableBody!.parentElement;
    expect(card).not.toBeNull();
    expect(card!.contains(getModalApply())).toBe(true);
    expect(card!.contains(getModalCancel())).toBe(true);

    // The scrollable body must not contain the footer buttons (they live in a separate sibling).
    expect(scrollableBody!.contains(getModalApply())).toBe(false);
    expect(scrollableBody!.contains(getModalCancel())).toBe(false);
  });

  it('opens the modal for the clicked language pill', async () => {
    const { getLanguageItems, getModalApply } = renderEditor({
      translations: { en: { code: 'english' } },
    });

    expect(getLanguageItems()).toHaveLength(1);

    // Clicking the only pill opens the modal.
    fireEvent.click(getLanguageItems()[0]!);

    await waitFor(() => {
      expect(getModalApply()).not.toBeNull();
    });
  });

  it('edits the Form draft without persisting until Apply, then commits on Apply', async () => {
    const { getLanguageItems, getModalApply, getGridCells, getTranslations } = renderEditor({
      translations: { en: { code: 'english' } },
    });

    fireEvent.click(getLanguageItems()[0]!);

    // The Form tab is the default; the grid renders with the saved value.
    await waitFor(() => {
      expect(getGridCells().length).toBeGreaterThan(0);
      expect(getGridCells()[0]!.value).toBe('english');
    });

    // Editing a cell updates the draft (the textarea reflects it)…
    fireEvent.change(getGridCells()[0]!, { target: { value: 'edited' } });

    await waitFor(() => {
      expect(getGridCells()[0]!.value).toBe('edited');
    });

    // …but the committed form field is still the original value (draft only).
    expect(getTranslations().en).toEqual({ code: 'english' });

    // Apply writes the draft back into the form and closes the modal.
    fireEvent.click(getModalApply()!);

    await waitFor(() => {
      expect(getTranslations().en).toEqual({ code: 'edited' });
      expect(getModalApply()).toBeNull();
    });
  });

  it('seeds the JSON editor from the draft and merges pasted JSON on Apply', async () => {
    const { getLanguageItems, getModalApply, getJsonEditor, getTabByText, getTranslations } =
      renderEditor({
        translations: { en: { code: 'english' } },
      });

    fireEvent.click(getLanguageItems()[0]!);

    await waitFor(() => {
      expect(getModalApply()).not.toBeNull();
    });

    // Switch to JSON mode (click the JSON tab; found by text since the DOM also holds language
    // pills with `role="tab"`).
    fireEvent.click(getTabByText('JSON')!);

    await waitFor(() => {
      expect(getJsonEditor()).not.toBeNull();
    });

    // The JSON editor is seeded with the serialized draft (sorted, 2-space).
    expect(getJsonEditor()!.value).toBe('{\n  "code": "english"\n}');

    // Paste a JSON object that both updates an existing key and adds a new one.
    fireEvent.change(getJsonEditor()!, {
      target: { value: '{\n  "code": "from-json",\n  "greeting": "hi"\n}' },
    });

    fireEvent.click(getModalApply()!);

    // Apply merges the JSON into the language's dictionary.
    await waitFor(() => {
      expect(getTranslations().en).toEqual({ code: 'from-json', greeting: 'hi' });
      expect(getModalApply()).toBeNull();
    });
  });

  it('blocks Apply and shows an error for invalid JSON', async () => {
    const { getLanguageItems, getModalApply, getJsonEditor, getTabByText, getTranslations } =
      renderEditor({
        translations: { en: { code: 'english' } },
      });

    fireEvent.click(getLanguageItems()[0]!);

    await waitFor(() => {
      expect(getModalApply()).not.toBeNull();
    });

    // Switch to JSON mode.
    fireEvent.click(getTabByText('JSON')!);

    await waitFor(() => {
      expect(getJsonEditor()).not.toBeNull();
    });

    // Type invalid JSON; the live-parse surfaces an error and disables Apply.
    fireEvent.change(getJsonEditor()!, { target: { value: '{ not json' } });

    await waitFor(() => {
      expect(getJsonEditor()!.dataset.error).toBeTruthy();
      expect(getModalApply()?.disabled).toBe(true);
    });

    // The modal stays open and the committed dictionary is unchanged (draft only).
    expect(getJsonEditor()).not.toBeNull();
    expect(getTranslations().en).toEqual({ code: 'english' });
  });

  it('rejects non-string JSON values with an error', async () => {
    const { getLanguageItems, getModalApply, getJsonEditor, getTabByText } = renderEditor({
      translations: { en: { code: 'english' } },
    });

    fireEvent.click(getLanguageItems()[0]!);

    await waitFor(() => {
      expect(getModalApply()).not.toBeNull();
    });

    fireEvent.click(getTabByText('JSON')!);

    await waitFor(() => {
      expect(getJsonEditor()).not.toBeNull();
    });

    // A numeric value violates the "translations values must be strings" rule.
    fireEvent.change(getJsonEditor()!, { target: { value: '{ "code": 1234 }' } });

    await waitFor(() => {
      expect(getJsonEditor()!.dataset.error).toBeTruthy();
      expect(getModalApply()?.disabled).toBe(true);
    });
  });

  it('discards draft changes when closing without Apply (with a dirty-confirm)', async () => {
    const { getLanguageItems, getModalCancel, getGridCells, getTranslations, getButtonByText } =
      renderEditor({ translations: { en: { code: 'english' } } });

    fireEvent.click(getLanguageItems()[0]!);

    await waitFor(() => {
      expect(getGridCells().length).toBeGreaterThan(0);
    });

    // Make the draft dirty.
    fireEvent.change(getGridCells()[0]!, { target: { value: 'edited' } });

    await waitFor(() => {
      expect(getGridCells()[0]!.value).toBe('edited');
    });

    // Closing (Cancel) with a dirty draft surfaces the unsaved-changes confirm.
    fireEvent.click(getModalCancel()!);

    await waitFor(() => {
      expect(getButtonByText('Leave page')).not.toBeUndefined();
    });

    // Confirm → discard → modal closes; the committed field kept the original value.
    fireEvent.click(getButtonByText('Leave page')!);

    await waitFor(() => {
      expect(getModalCancel()).toBeNull();
    });
    expect(getTranslations().en).toEqual({ code: 'english' });
  });

  it('keeps the modal open when cancelling the dirty-confirm', async () => {
    const { getLanguageItems, getModalCancel, getGridCells, getButtonByText } = renderEditor({
      translations: { en: { code: 'english' } },
    });

    fireEvent.click(getLanguageItems()[0]!);

    await waitFor(() => {
      expect(getGridCells().length).toBeGreaterThan(0);
    });

    fireEvent.change(getGridCells()[0]!, { target: { value: 'edited' } });

    fireEvent.click(getModalCancel()!);

    await waitFor(() => {
      expect(getButtonByText('Stay on page')).not.toBeUndefined();
    });

    // Cancel the confirm → the editor modal stays open with the draft intact.
    fireEvent.click(getButtonByText('Stay on page')!);

    await waitFor(() => {
      expect(getModalCancel()).not.toBeNull();
      expect(getGridCells()[0]!.value).toBe('edited');
    });
  });

  it('removes a language via the per-pill delete button (modal closed)', async () => {
    const { getLanguageItems, getDeleteButtons } = renderEditor({
      translations: { en: { code: 'english' }, 'zh-CN': { code: '中文' } },
    });

    expect(getLanguageItems()).toHaveLength(2);
    expect(getDeleteButtons()).toHaveLength(2);

    // Delete the second pill (`zh-CN`); one pill remains and no modal opens.
    fireEvent.click(getDeleteButtons()[1]!);

    await waitFor(() => {
      expect(getLanguageItems()).toHaveLength(1);
    });
  });

  it('falls back to the first remaining language after deleting the selected one', async () => {
    const { getLanguageItems, getDeleteButtons, getModalApply } = renderEditor({
      translations: { en: { code: 'english' }, 'zh-CN': { code: '中文' } },
    });

    // `en` is the default-selected language; the delete trash on its pill deletes it.
    expect(getLanguageItems()).toHaveLength(2);

    fireEvent.click(getDeleteButtons()[0]!);

    // After deleting `en`, `zh-CN` remains (fallback) — no modal opens (delete does not open it).
    await waitFor(() => {
      expect(getLanguageItems()).toHaveLength(1);
      expect(getModalApply()).toBeNull();
    });
  });

  it('surfaces every {{t.*}} placeholder in the modal Form grid (email-mode)', async () => {
    const emailTemplatesItem: ConnectorConfigFormItem = {
      key: 'templates',
      label: 'Templates',
      type: ConnectorConfigFormItemType.Json,
      required: false,
      defaultValue: [],
    };

    const { getLanguageItems, getGridCells } = renderEditor({
      formItem: emailTemplatesItem,
      connectorType: ConnectorType.Email,
      templates: [
        {
          usageType: 'SignIn',
          subject: '{{t.signInTitle}}',
          content: '{{t.signInDescription}} expires {{t.signInExpiry}}',
          contentType: 'text/html',
        },
      ],
      translations: { en: {} },
    });

    // Open the modal on the existing `en` language.
    fireEvent.click(getLanguageItems()[0]!);

    // Every `{{t.*}}` placeholder from `subject` + `content` appears as its own grid row.
    await waitFor(() => {
      const keys = Array.from(document.querySelectorAll<HTMLElement>('table code')).map(
        (element) => element.textContent ?? ''
      );
      expect(keys).toEqual(
        expect.arrayContaining(['signInTitle', 'signInDescription', 'signInExpiry'])
      );
    });

    expect(getGridCells().length).toBeGreaterThanOrEqual(3);
  });

  it('renders no translation grid while the modal is closed', () => {
    const { getGridCells } = renderEditor({ translations: { en: { code: 'english' } } });

    // Languages exist but the modal is closed → no inline grid.
    expect(getGridCells()).toHaveLength(0);
  });

  // --- save-footer / isDirty determinism -------------------------------------
  //
  // The save footer is driven by `formState.isDirty`. Editing templates or translations in the
  // classic Ubill SMS editor must reliably flip `isDirty` so the footer appears; loading a saved
  // connector must not spuriously dirty the form.

  it('flips formState.isDirty after a localization Apply edit (save footer appears)', async () => {
    const defaultValues = buildDefaultValues({ translations: { en: { code: 'english' } } });

    function DirtyProbe() {
      // Reading `formState.isDirty` inside a rendered component subscribes this probe to dirty
      // updates, so it re-renders (and mirrors the value into the DOM) whenever isDirty flips.
      const { formState } = useFormContext<ConnectorFormType>();

      return <div data-testid="dirty-probe">{formState.isDirty ? 'true' : 'false'}</div>;
    }

    function Harness() {
      const methods = useForm<ConnectorFormType>({ defaultValues });

      return (
        <FormProvider {...methods}>
          <MemoryRouter>
            <ConnectorTemplatesEditor formItem={templatesItem} connectorType={ConnectorType.Sms} />
          </MemoryRouter>
          <CommittedTranslationsProbe />
          <DirtyProbe />
        </FormProvider>
      );
    }

    render(<Harness />);

    // Baseline: not dirty on load.
    await waitFor(() => {
      expect(getIsDirtyFromProbe()).toBe(false);
    });

    fireEvent.click(document.querySelectorAll('.languageItem')[0]!);

    await waitFor(() => {
      expect(getModalApply()).not.toBeNull();
    });

    await waitFor(() => {
      expect(getModalGridCells().length).toBeGreaterThan(0);
    });

    fireEvent.change(getModalGridCells()[0]!, { target: { value: 'edited' } });

    fireEvent.click(getModalApply()!);

    await waitFor(() => {
      expect(getTranslations().en).toEqual({ code: 'edited' });
    });

    // After Apply, the form must be dirty so the save footer appears.
    await waitFor(() => {
      expect(getIsDirtyFromProbe()).toBe(true);
    });
  });

  it('flips formState.isDirty after editing a template field (save footer appears)', async () => {
    const defaultValues = buildDefaultValues();

    function DirtyProbe() {
      const { formState } = useFormContext<ConnectorFormType>();

      return <div data-testid="dirty-probe">{formState.isDirty ? 'true' : 'false'}</div>;
    }

    function Harness() {
      const methods = useForm<ConnectorFormType>({ defaultValues });

      return (
        <FormProvider {...methods}>
          <MemoryRouter>
            <ConnectorTemplatesEditor formItem={templatesItem} connectorType={ConnectorType.Sms} />
          </MemoryRouter>
          <DirtyProbe />
        </FormProvider>
      );
    }

    render(<Harness />);

    // Baseline: not dirty on load.
    await waitFor(() => {
      expect(getIsDirtyFromProbe()).toBe(false);
    });

    // The classic SMS editor renders a `Textarea` for each row's `content` field. The mocked
    // CodeEditor carries `data-testid="json-editor"`; the SMS content `Textarea` does not, so it is
    // matched by excluding that testid.
    const contentTextarea = document.querySelector<HTMLTextAreaElement>(
      'textarea:not([data-testid])'
    );
    expect(contentTextarea).not.toBeNull();

    fireEvent.change(contentTextarea!, { target: { value: 'Your edited code is {{code}}.' } });

    // The template-field edit flips isDirty so the save footer appears.
    await waitFor(() => {
      expect(getIsDirtyFromProbe()).toBe(true);
    });
  });
});
/* eslint-enable max-lines */
