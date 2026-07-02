/* eslint-disable max-lines */
import type { ConnectorConfigFormItem, ConnectorType } from '@logto/connector-kit';
import {
  isLanguageTag,
  languages as uiLanguageNameMapping,
  type LanguageTag,
} from '@logto/language-kit';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFormContext, type FieldPath } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import LanguageItem from '@/components/LocalizationEditor/LanguageItem';
import useLocalizationEditorContext from '@/components/LocalizationEditor/use-localization-editor-context';
import ConfirmModal from '@/ds-components/ConfirmModal';
import type { ConnectorFormType } from '@/types/connector';

import AddLocalizationsButton from './AddLocalizationsButton';
import { type EmailContentType } from './EmailTemplateRow';
import TemplateRows from './TemplateRows';
import TranslationEditorModal from './TranslationEditorModal';
import UnifiedEditorModeToggle from './UnifiedEditorModeToggle';
import styles from './index.module.scss';
import {
  buildEmptyTemplateRow,
  contentTypeKeyFor,
  deriveEditorMode,
  extractableFieldsFor,
} from './mode';
import { unifiedConnectorFactoryIds } from './unified';
import {
  deriveLanguages,
  ensureAllTemplateTypes,
  extractTranslationKeys,
  safeJsonParse,
  safeJsonStringify,
  sortTemplatesByFillStatus,
} from './utils';

type Props = {
  /** The `templates`/`deliveries` form item this editor is rendered for. */
  readonly formItem: ConnectorConfigFormItem;
  /** The owning connector's type; drives SMS vs. email rendering. */
  readonly connectorType: ConnectorType;
  /** The connector factory id (e.g. `ubill-sms`, `mailgun-email`); gates the Unified toggle. */
  readonly connectorFactoryId?: string;
  /** The list of all form items in the configuration. */
  readonly formItems?: ConnectorConfigFormItem[];
};

/**
 * A connector template row in its normalized, mode-agnostic form. `usageType` is always present;
 * the remaining fields are provider-specific (`content`, `subject`, `contentType`/`type`,
 * `html`/`text`, `templateAlias`, …) and are read/written verbatim by the editor.
 */
type TemplateRow = { usageType: string } & Record<string, unknown>;

type TranslationMap = Record<string, Record<string, string>>;

// The sibling `translations` form item is rendered as `null` by `ConfigFormFields` and owned
// entirely by this editor, so its react-hook-form path is fixed.
const TRANSLATIONS_FIELD: FieldPath<ConnectorFormType> = 'formConfig.translations';

/**
 * Inline, mode-aware connector templates editor shared by SMS and email connectors.
 *
 * Owns two JSON form fields on the connector config form:
 * - `formConfig.templates` (or `formConfig.deliveries` for Mailgun) — the provider-specific
 *   template rows. Localizable string fields (`content`, `subject`, `html`, `text`) support
 *   `{{code}}` payload handlebars and `{{t.key}}` localization placeholders (resolved at send time
 *   via `getLocalizedPayload` + `replaceSendMessageHandlebars`).
 * - `formConfig.translations` — a `Record<LanguageTag, Record<string, string>>` dictionary
 *   consumed by `getLocalizedPayload`.
 *
 * The row shape is derived from the connector type + form-item key + row contents (see
 * {@link deriveEditorMode}): SMS, common email, or Postmark aliases. Mailgun's `deliveries` record
 * is edited through the unified editor and never reaches the classic row renderer.
 * Auto-detects every supported {@link TemplateType} (see {@link ensureAllTemplateTypes}) so the
 * editor always shows the full delivery-template set, without polluting the saved config (synthetic
 * rows persist only once edited).
 *
 * Layout (compact, inline within the owning "Parameter configuration" card — no nested cards):
 * - "Template translations available": language pills + an "Add localizations" button that opens a
 *   popover (searchable language picker + Apply). Clicking a pill — or applying an added language —
 *   opens the {@link TranslationEditorModal} for that language (draft + Apply, Form/JSON toggle).
 * - "Delivery templates": a single bordered container holding every usage type, each separated by a
 *   divider. Email content uses a `CodeEditor`; SMS uses a `Textarea`; `Subject` is email-only.
 *
 * The per-language translation grid is no longer rendered inline; it lives inside the modal, which
 * commits its draft to the form on Apply (draft-and-apply model mirroring the sibling
 * `LocalizationEditor` modal). Closing with a dirty draft surfaces a `ConfirmModal`.
 *
 * Changes are written back as pretty-printed JSON via react-hook-form's `setValue`
 * (marking the form dirty). Reuses the Phase 0 localization-editor context shell
 * (`useLocalizationEditorContext`) for `selectedLanguage` + `isDirty` + dirty-confirm wiring, but
 * renders `LanguageItem` pills directly so the pill click opens the modal (the shared
 * `LocalizationNav` is left untouched).
 */
function ConnectorTemplatesEditor({
  formItem,
  connectorType,
  connectorFactoryId,
  formItems,
}: Props) {
  const isUnifiedConnector =
    connectorFactoryId !== undefined && unifiedConnectorFactoryIds.has(connectorFactoryId);

  const { t } = useTranslation(undefined, { keyPrefix: 'admin_console' });
  const { watch, getValues, setValue, register } = useFormContext<ConnectorFormType>();
  const { context, Provider } = useLocalizationEditorContext();
  const {
    selectedLanguage,
    setSelectedLanguage,
    isDirty,
    setIsDirty,
    confirmationState,
    setConfirmationState,
  } = context;
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Resolve the templates/deliveries field path from the form item this editor was rendered for
  // (`formItem.key` is `'templates'` or `'deliveries'`). The cast bridges react-hook-form's literal
  // `FieldPath` union with a runtime-derived key.
  const templatesField = useMemo(
    // eslint-disable-next-line no-restricted-syntax -- `formItem.key` is a runtime string; react-hook-form's `FieldPath` is a literal union that cannot be derived from a dynamic key without a cast.
    () => `formConfig.${formItem.key}` as FieldPath<ConnectorFormType>,
    [formItem.key]
  );

  const templatesRaw = watch(templatesField);
  const translationsRaw = watch(TRANSLATIONS_FIELD);

  // Register the two JSON fields this editor owns with react-hook-form. Neither is rendered as a
  // standalone input by `ConfigFormFields` (`templates`/`deliveries` is rendered by this editor and
  // `translations` is skipped entirely), so they would otherwise be unregistered. Registering them
  // (with no rules, no ref) makes `setValue(..., { shouldDirty: true })` deterministically flip
  // `formState.isDirty` and track `dirtyFields` — without it, the save footer's dirty state is
  // unreliable across edits to templates/translations. `register` is stable and the field paths are
  // memoized, so this runs once per mount.
  useEffect(() => {
    register(templatesField);
    register(TRANSLATIONS_FIELD);
  }, [register, templatesField]);

  // Parse raw JSON into rows. `deliveries` is a `Record<usageType, config>`; normalize it to a row
  // array for rendering and write it back as a record on edit (the `as` shape asserts live inside
  // `safeJsonParse`, mirroring the SMS precedent).
  const parsedRows = useMemo<TemplateRow[]>(() => {
    if (formItem.key === 'deliveries') {
      const record = safeJsonParse<Record<string, Record<string, unknown>>>(templatesRaw) ?? {};

      return Object.entries(record).map(([usageType, config]) => ({ usageType, ...config }));
    }

    return safeJsonParse<TemplateRow[]>(templatesRaw) ?? [];
  }, [templatesRaw, formItem.key]);

  const mode = useMemo(
    () => deriveEditorMode(connectorType, formItem.key, parsedRows),
    [connectorType, formItem.key, parsedRows]
  );

  // The content-type field key (`contentType` for SMTP, `type` for SendGrid/MailJunky) is uniform
  // across a connector's rows; derive it once from the configured rows so the selector writes back
  // to the correct key. Computed from `parsedRows` (not the auto-detected display rows) so a
  // connector with no configured rows degrades to "no selector" deterministically.
  const contentTypeKey = useMemo<'contentType' | 'type' | undefined>(
    () => contentTypeKeyFor(parsedRows[0]),
    [parsedRows]
  );

  // Display rows: the configured rows plus an empty row for every supported template type that the
  // connector does not yet define (see {@link ensureAllTemplateTypes}). Synthetic rows are
  // display-only until one of their fields is edited, so existing configs are never polluted.
  const templates = useMemo<TemplateRow[]>(
    () =>
      ensureAllTemplateTypes(parsedRows, (usageType) =>
        buildEmptyTemplateRow(usageType, mode, contentTypeKey)
      ),
    [parsedRows, mode, contentTypeKey]
  );

  // Render order: filled templates surfaced first, `Generic` parked between filled and empty, and
  // empty (unused) templates pushed last — so the templates actually in use read at the top of the
  // box. Applied only for rendering; the canonical `templates` order still feeds
  // `extractTranslationKeys`/`allKeys` so translation-key first-seen order is unaffected.
  const sortedTemplates = useMemo(
    () => sortTemplatesByFillStatus(templates, mode),
    [templates, mode]
  );

  const translations = useMemo<TranslationMap>(
    () => safeJsonParse<TranslationMap>(translationsRaw) ?? {},
    [translationsRaw]
  );

  // Keys surfaced in the translations grid: every `{{t.key}}` referenced by any template's
  // localizable fields, unioned with every key already defined in any language's dictionary.
  // Sorted for stable ordering.
  const allKeys = useMemo(() => {
    const fromTemplates = extractTranslationKeys(templates, extractableFieldsFor(mode));
    const fromTranslations = Object.values(translations).flatMap((dictionary) =>
      Object.keys(dictionary)
    );

    return [...new Set([...fromTemplates, ...fromTranslations])].slice().sort();
  }, [templates, translations, mode]);

  const languages = useMemo<LanguageTag[]>(() => deriveLanguages(translations), [translations]);

  const availableLanguageOptions = useMemo(
    () =>
      Object.keys(uiLanguageNameMapping)
        .filter(
          (languageTag): languageTag is LanguageTag =>
            isLanguageTag(languageTag) && !languages.includes(languageTag)
        )
        .map((languageTag) => ({
          value: languageTag,
          title: uiLanguageNameMapping[languageTag],
        })),
    [languages]
  );

  // Keep `selectedLanguage` valid so opening the translation modal (via a pill click or after an
  // add) always seeds the draft from a real language: when the (context-default) selected language
  // is not among the configured languages, fall back to the first one. Runs once per language-set
  // change; idempotent.
  useEffect(() => {
    if (languages.length > 0 && !languages.includes(selectedLanguage)) {
      const firstLanguage = languages[0];

      if (firstLanguage) {
        setSelectedLanguage(firstLanguage);
      }
    }
  }, [languages, selectedLanguage, setSelectedLanguage]);

  const writeTemplates = useCallback(
    (next: unknown) => {
      setValue(templatesField, safeJsonStringify(next), { shouldDirty: true });
    },
    [setValue, templatesField]
  );

  const writeTranslations = useCallback(
    (next: TranslationMap) => {
      setValue(TRANSLATIONS_FIELD, safeJsonStringify(next), { shouldDirty: true });
    },
    [setValue]
  );

  // Generic, stable single-field write-back. Reads the latest form value via `getValues` instead of
  // closing over the reactive `templates` snapshot, so memoized rows re-render only when their own
  // value prop changes. Mailgun `deliveries` writes back to the record (preserving all other keys);
  // array connectors write back to the matching row, appending a freshly-built empty row when the
  // edited usage type was auto-detected (synthetic) and not yet in the persisted config.
  const updateTemplateField = useCallback(
    (usageType: string, field: string, value: string) => {
      if (formItem.key === 'deliveries') {
        const current =
          safeJsonParse<Record<string, Record<string, unknown>>>(getValues(templatesField)) ?? {};
        // Seed a never-persisted deliveries usage type with its empty Mailgun shape (no `usageType`
        // key — the record is keyed by it) so the row's optional fields stay visible after edit.
        const currentRow = usageType in current ? current[usageType] : { subject: '', html: '' };

        writeTemplates({ ...current, [usageType]: { ...currentRow, [field]: value } });

        return;
      }

      const current = safeJsonParse<TemplateRow[]>(getValues(templatesField)) ?? [];
      // Update matching row(s) in place, or — when the edited usage type was auto-detected
      // (synthetic) — append a provider-appropriate empty row carrying the connector's
      // content-type (if any) so the field is consistent on re-render.
      writeTemplates(
        current.some((row) => row.usageType === usageType)
          ? current.map((row) => (row.usageType === usageType ? { ...row, [field]: value } : row))
          : [
              ...current,
              { ...buildEmptyTemplateRow(usageType, mode, contentTypeKey), [field]: value },
            ]
      );
    },
    [getValues, templatesField, writeTemplates, formItem.key, mode, contentTypeKey]
  );

  // Per-field stable change handlers (a single memoized object keyed by field, closing over only
  // the stable `updateTemplateField`), so memoized rows see referentially-stable callbacks across
  // keystrokes. `onContentTypeChange` has a distinct signature (it also carries the field key) so
  // it stays standalone.
  const fieldHandlers = useMemo(() => {
    const handler = (field: string) => (usageType: string, value: string) => {
      updateTemplateField(usageType, field, value);
    };

    return {
      content: handler('content'),
      subject: handler('subject'),
      html: handler('html'),
      text: handler('text'),
      alias: handler('templateAlias'),
    };
  }, [updateTemplateField]);

  const onContentTypeChange = useCallback(
    (usageType: string, key: 'contentType' | 'type', contentType: EmailContentType) => {
      updateTemplateField(usageType, key, contentType);
    },
    [updateTemplateField]
  );

  // Add a language via the "Add localizations" popover (Apply): write an empty dictionary, select
  // the language, and open the translation modal on it so the user can start filling values.
  const onAddLanguage = useCallback(
    (languageTag: LanguageTag) => {
      if (languageTag in translations) {
        return;
      }
      writeTranslations({ ...translations, [languageTag]: {} });
      setSelectedLanguage(languageTag);
      setIsModalOpen(true);
    },
    [translations, writeTranslations, setSelectedLanguage]
  );

  // Clicking a language pill selects it and opens the translation modal. The modal's blocking
  // overlay renders background pills non-clickable while it is open, so there is no pill-driven
  // dirty-switch scenario to guard here (apply/close must happen first).
  const onSelectLanguage = useCallback(
    (languageTag: LanguageTag) => {
      setSelectedLanguage(languageTag);
      setIsModalOpen(true);
    },
    [setSelectedLanguage]
  );

  // Delete a language's translations and persist immediately (shouldDirty: true). After deleting,
  // keep `selectedLanguage` valid (fall back to the first remaining language). Reads the latest form
  // value via `getValues` instead of the reactive `translations` snapshot so two rapid deletes
  // cannot race. The modal (if open) sits behind its own blocking overlay and is not affected.
  const onDeleteLanguage = useCallback(
    (languageTag: LanguageTag) => {
      const currentTranslations =
        safeJsonParse<TranslationMap>(getValues(TRANSLATIONS_FIELD)) ?? {};
      const nextTranslations = Object.fromEntries(
        Object.entries(currentTranslations).filter(([tag]) => tag !== languageTag)
      );
      writeTranslations(nextTranslations);

      const remainingLanguages = deriveLanguages(nextTranslations);

      if (remainingLanguages.length === 0) {
        return;
      }

      // Switch to the first remaining language if the current selection was the deleted one.
      if (!remainingLanguages.includes(selectedLanguage)) {
        const firstRemaining = remainingLanguages[0];

        if (firstRemaining) {
          setSelectedLanguage(firstRemaining);
        }
      }
    },
    [getValues, writeTranslations, selectedLanguage, setSelectedLanguage]
  );

  // Close request from the modal (X / Esc / overlay). With a dirty draft, defer to a `ConfirmModal`
  // so the user does not silently lose uncommitted edits; the modal stays mounted during the
  // confirm (its overlay blocks background interaction).
  const onModalRequestClose = useCallback(() => {
    if (isDirty) {
      setConfirmationState('try-close');

      return;
    }

    setIsModalOpen(false);
  }, [isDirty, setConfirmationState]);

  // Apply the modal's draft back into the form field, then close. Reads the latest form value via
  // `getValues` so the merge is not based on a stale snapshot.
  const onModalApply = useCallback(
    (languageTag: LanguageTag, draft: Record<string, string>) => {
      const currentTranslations =
        safeJsonParse<TranslationMap>(getValues(TRANSLATIONS_FIELD)) ?? {};
      writeTranslations({ ...currentTranslations, [languageTag]: draft });
      setIsModalOpen(false);
      setIsDirty(false);
    },
    [getValues, writeTranslations, setIsDirty]
  );

  return (
    <Provider value={context}>
      <div className={styles.editor}>
        <UnifiedEditorModeToggle
          formItem={formItem}
          connectorType={connectorType}
          connectorFactoryId={connectorFactoryId}
          formItems={formItems}
        >
          {!isUnifiedConnector && (
            <>
              <section className={styles.section}>
                <h4 className={styles.sectionTitle}>
                  {t('connector_details.template_editor.template_translations_available')}
                </h4>
                <div className={styles.languagesRow}>
                  {languages.map((languageTag) => (
                    <LanguageItem
                      key={languageTag}
                      languageTag={languageTag}
                      isSelected={selectedLanguage === languageTag}
                      variant="inline"
                      onClick={() => {
                        onSelectLanguage(languageTag);
                      }}
                      onDelete={() => {
                        onDeleteLanguage(languageTag);
                      }}
                    />
                  ))}
                  <AddLocalizationsButton
                    options={availableLanguageOptions}
                    onApply={onAddLanguage}
                  />
                </div>
              </section>
              <section className={styles.section}>
                <h4 className={styles.sectionTitle}>
                  {t('connector_details.template_editor.delivery_templates')}
                </h4>
                <div className={styles.templates}>
                  <TemplateRows
                    mode={mode}
                    sortedTemplates={sortedTemplates}
                    contentTypeKey={contentTypeKey}
                    fieldHandlers={fieldHandlers}
                    onContentTypeChange={onContentTypeChange}
                  />
                </div>
              </section>
              {isModalOpen && (
                <TranslationEditorModal
                  languageTag={selectedLanguage}
                  keys={allKeys}
                  values={translations[selectedLanguage] ?? {}}
                  onApply={onModalApply}
                  onRequestClose={onModalRequestClose}
                />
              )}
            </>
          )}
        </UnifiedEditorModeToggle>
      </div>
      {!isUnifiedConnector && (
        <ConfirmModal
          isOpen={confirmationState === 'try-close'}
          confirmButtonText="general.leave_page"
          cancelButtonText="general.stay_on_page"
          onCancel={() => {
            setConfirmationState('none');
          }}
          onConfirm={() => {
            setIsModalOpen(false);
            setIsDirty(false);
            setConfirmationState('none');
          }}
        >
          {t('general.unsaved_changes_warning')}
        </ConfirmModal>
      )}
    </Provider>
  );
}

export default ConnectorTemplatesEditor;
/* eslint-enable max-lines */
