import { type ConnectorConfigFormItem, type ConnectorType } from '@logto/connector-kit';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFormContext, useWatch, type FieldPath } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import TabNav, { TabNavItem } from '@/ds-components/TabNav';
import type { ConnectorFormType } from '@/types/connector';

import UnifiedLocalizationsTab from './UnifiedLocalizationsTab';
import UnifiedTemplateTab from './UnifiedTemplateTab';
import UnifiedVariablesTab from './UnifiedVariablesTab';
import styles from './index.module.scss';
import {
  compileUnified,
  dummyPayload,
  kindForConnectorType,
  type UnifiedTemplate,
  type UnifiedTranslations,
  type VariablesTable,
} from './unified';
import { safeJsonParse, safeJsonStringify, jsonFieldsEqual } from './utils';

type Props = {
  /** The owning connector's type (always `Email` for the allowlisted Mailgun connector). */
  readonly connectorType: ConnectorType;
  readonly connectorFactoryId?: string;
  readonly formItems?: ConnectorConfigFormItem[];
};

type TabKey = 'template' | 'variables' | 'localizations';

const EMPTY_TEMPLATE: UnifiedTemplate = {};
const EMPTY_VARIABLES: VariablesTable = {};
const EMPTY_TRANSLATIONS: UnifiedTranslations = {};

/**
 * The dev-flagged Unified template editor for Mailgun. A three-tab host (Template /
 * Variables / Localizations) that owns four defensive `formConfig` fields
 * (`unifiedTemplate`, `variables`, `unifiedTranslations`, `templateEditorMode`) and compiles them
 * on edit into the existing `deliveries` + `translations` mirror fields the Mailgun connector
 * already consumes — so the persisted + runtime contract is byte-for-byte unchanged and the send
 * path needs zero changes.
 *
 * The compile-on-edit effect re-runs `compileUnified` whenever the unified source changes and
 * writes the compiled rows + flat translations to the mirror fields ONLY when they differ from the
 * form's current mirror value — so loading a saved unified connector (whose compiled mirror
 * already matches the recompiled output) does not spuriously dirty the form. The effect is skipped
 * entirely when the unified template is empty, so toggling Classic → Unified with no authored
 * unified content does not clobber the classic per-type rows (the {@link UnifiedEditorModeToggle}
 * seeds the unified fields best-effort from the classic rows first).
 */
function UnifiedTemplateEditor({ connectorType, connectorFactoryId, formItems }: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: 'admin_console' });
  const { setValue, getValues, register, formState } = useFormContext<ConnectorFormType>();
  const { isSubmitting } = formState;
  const [activeTab, setActiveTab] = useState<TabKey>('template');

  const kind = kindForConnectorType(connectorType);

  const rowsField: FieldPath<ConnectorFormType> = 'formConfig.deliveries';
  // The unified source fields the editor owns (source of truth) and the two classic mirror fields
  // it recompiles into. None are rendered as standalone inputs by `ConfigFormFields`, so they are
  // unregistered by default. Registering them (no rules, no ref) makes `setValue` deterministically
  // update `formState.isDirty`/`dirtyFields` for user edits to the source fields. The mirror fields
  // are written with `shouldDirty: false` (they are derived), so registering them only stabilizes
  // their tracked state.
  const unifiedTemplateField: FieldPath<ConnectorFormType> = 'formConfig.unifiedTemplate';
  const variablesField: FieldPath<ConnectorFormType> = 'formConfig.variables';
  const unifiedTranslationsField: FieldPath<ConnectorFormType> = 'formConfig.unifiedTranslations';
  const unifiedSubjectsField: FieldPath<ConnectorFormType> = 'formConfig.unifiedSubjects';
  const translationsField: FieldPath<ConnectorFormType> = 'formConfig.translations';

  const templateRaw: unknown = useWatch({ name: unifiedTemplateField });
  const variablesRaw: unknown = useWatch({ name: variablesField });
  const translationsRaw: unknown = useWatch({ name: unifiedTranslationsField });
  const subjectsRaw: unknown = useWatch({ name: unifiedSubjectsField });

  // Register the unified source + mirror fields once. `register` is stable and the field paths are
  // module/instance constants, so this runs once per mount.
  useEffect(() => {
    register(unifiedTemplateField);
    register(variablesField);
    register(unifiedTranslationsField);
    register(unifiedSubjectsField);
    register(rowsField);
    register(translationsField);
  }, [
    register,
    unifiedTemplateField,
    variablesField,
    unifiedTranslationsField,
    unifiedSubjectsField,
    rowsField,
    translationsField,
  ]);

  const template = useMemo<UnifiedTemplate>(
    () => safeJsonParse<UnifiedTemplate>(templateRaw) ?? EMPTY_TEMPLATE,
    [templateRaw]
  );
  const variables = useMemo<VariablesTable>(
    () => safeJsonParse<VariablesTable>(variablesRaw) ?? EMPTY_VARIABLES,
    [variablesRaw]
  );
  const translations = useMemo<UnifiedTranslations>(
    () => safeJsonParse<UnifiedTranslations>(translationsRaw) ?? EMPTY_TRANSLATIONS,
    [translationsRaw]
  );
  const unifiedSubjects = useMemo<Record<string, string>>(
    () => safeJsonParse<Record<string, string>>(subjectsRaw) ?? {},
    [subjectsRaw]
  );

  const compiled = useMemo(
    () => compileUnified({ kind, template, variables, translations, unifiedSubjects }),
    [kind, template, variables, translations, unifiedSubjects]
  );

  const hasUnifiedContent = useMemo(
    () =>
      Object.values(template).some((value) => typeof value === 'string' && value.length > 0) ||
      Object.values(unifiedSubjects).some((value) => typeof value === 'string' && value.length > 0),
    [template, unifiedSubjects]
  );

  const [parseError, setParseError] = useState<string | undefined>(undefined);

  // Distinguish "unified mode has never been authored" (e.g. Start Fresh toggle) from
  // "user intentionally cleared the unified source". The flag starts true when the persisted
  // unified template already carries authored content, and flips to true on the first non-empty
  // edit. When false and the unified source is empty, we keep any classic rows intact.
  const [hasEverEditedUnified, setHasEverEditedUnified] = useState(() => {
    const parsed = safeJsonParse<UnifiedTemplate>(templateRaw);
    const subjects = safeJsonParse<Record<string, string>>(subjectsRaw) ?? {};
    return (
      Object.values(parsed ?? {}).some((value) => typeof value === 'string' && value.length > 0) ||
      Object.values(subjects).some((value) => typeof value === 'string' && value.length > 0)
    );
  });

  useEffect(() => {
    if (!hasEverEditedUnified && hasUnifiedContent) {
      setHasEverEditedUnified(true);
    }
  }, [hasEverEditedUnified, hasUnifiedContent]);

  const debounceTimerRef = useRef<NodeJS.Timeout>();
  const flushRef = useRef<() => void>();
  const containerRef = useRef<HTMLDivElement>(null);

  const writeBack = useCallback(() => {
    // Never mirror a structurally invalid unified source into deliveries — malformed <If> tags
    // would leak into sent messages. The existing mirror is kept until the error is fixed.
    if (parseError) {
      return;
    }

    // When the user has cleared the unified source, explicitly mirror an empty deliveries record
    // so stale compiled rows do not survive the save. Skip this on the initial toggle into unified
    // mode (Start Fresh) so classic rows are not clobbered before the user authors anything.
    if (!hasUnifiedContent) {
      if (hasEverEditedUnified) {
        const emptyRows = { Generic: { html: '' } };
        const emptyRowsJson = safeJsonStringify(emptyRows);
        const currentRows = getValues(rowsField);

        // `shouldDirty: false` — the mirror is derived; the form's dirty state is already driven by
        // the source-field edit (`onTemplateChange` set `unifiedTemplate` with `shouldDirty: true`).
        // Writing the mirror with `shouldDirty: true` here would spuriously dirty the form whenever a
        // recompile expands/collapses rows relative to a stale saved mirror (e.g. on load).
        if (!jsonFieldsEqual(emptyRowsJson, currentRows)) {
          setValue(rowsField, emptyRowsJson, { shouldDirty: false });
        }
      }

      return;
    }

    // `compiled.rows` is the `CompiledRows` wrapper; emit the inner `deliveries` record the
    // Mailgun connector consumes.
    const rowData = compiled.rows.deliveries;
    const rowsJson = safeJsonStringify(rowData);
    const translationsJson = safeJsonStringify(compiled.translations);
    const currentRows = getValues(rowsField);
    const currentTranslations = getValues(translationsField);

    // Write the compiled mirror only when it differs structurally from the form's current mirror
    // value. Comparison is on parsed structures (not serialized strings) so key order, optional-key
    // presence, and whitespace do not produce false diffs. `shouldDirty: false` because the mirror
    // is derived — the form's dirty state is driven by the unified source edits (which use
    // `shouldDirty: true`). This prevents spurious `isDirty` flips on load when a saved mirror is
    // stale relative to a deterministic recompile (e.g. the compiler expands a single unified
    // template into all delivery types while the saved mirror only stored a subset).
    if (!jsonFieldsEqual(rowsJson, currentRows)) {
      setValue(rowsField, rowsJson, { shouldDirty: false });
    }

    if (!jsonFieldsEqual(translationsJson, currentTranslations)) {
      setValue(translationsField, translationsJson, { shouldDirty: false });
    }
  }, [
    compiled,
    hasUnifiedContent,
    hasEverEditedUnified,
    parseError,
    rowsField,
    translationsField,
    setValue,
    getValues,
  ]);

  useEffect(() => {
    // eslint-disable-next-line @silverhand/fp/no-mutation
    flushRef.current = writeBack;
  }, [writeBack]);

  useEffect(() => {
    // Avoid queueing a debounce when the source is structurally invalid or when the mirror already
    // matches. The empty-source path is handled inside writeBack so it shares the same flush logic.
    if (parseError) {
      return;
    }

    if (!hasUnifiedContent && !hasEverEditedUnified) {
      return;
    }

    // Only queue a debounce when the compiled mirror differs structurally from the form's current
    // mirror value. On initial mount / loading of a consistent saved connector, they are equal, so
    // this prevents scheduling a timer on load. Comparison is on parsed structures (not serialized
    // strings) to avoid byte-order / optional-key false diffs.
    const rowData = compiled.rows.deliveries;
    const rowsJson = safeJsonStringify(rowData);
    const translationsJson = safeJsonStringify(compiled.translations);
    const currentRows = getValues(rowsField);
    const currentTranslations = getValues(translationsField);

    if (
      jsonFieldsEqual(rowsJson, currentRows) &&
      jsonFieldsEqual(translationsJson, currentTranslations)
    ) {
      return;
    }

    // eslint-disable-next-line @silverhand/fp/no-mutation
    debounceTimerRef.current = setTimeout(() => {
      writeBack();
      // eslint-disable-next-line @silverhand/fp/no-mutation
      debounceTimerRef.current = undefined;
    }, 250);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        // eslint-disable-next-line @silverhand/fp/no-mutation
        debounceTimerRef.current = undefined;
      }
    };
  }, [
    compiled,
    hasUnifiedContent,
    hasEverEditedUnified,
    parseError,
    writeBack,
    getValues,
    rowsField,
    translationsField,
  ]);

  // Flush on form submit event
  useEffect(() => {
    const form = containerRef.current?.closest('form');
    if (!form) {
      return;
    }

    const handleSubmit = () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        // eslint-disable-next-line @silverhand/fp/no-mutation
        debounceTimerRef.current = undefined;
      }
      flushRef.current?.();
    };

    form.addEventListener('submit', handleSubmit);
    return () => {
      form.removeEventListener('submit', handleSubmit);
    };
  }, []);

  // Flush when react-hook-form reports isSubmitting is true
  useEffect(() => {
    if (isSubmitting) {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        // eslint-disable-next-line @silverhand/fp/no-mutation
        debounceTimerRef.current = undefined;
      }
      flushRef.current?.();
    }
  }, [isSubmitting]);

  // Source-field change handlers. Each writes its unified source field with `shouldDirty: true` —
  // these are the edits that legitimately flip `formState.isDirty` and show the save footer. The
  // compiled mirror (`deliveries`/`translations`) is synced separately by `writeBack` with
  // `shouldDirty: false`. All are memoized with `useCallback` so memoized tab children see
  // referentially-stable callbacks across keystrokes (only `onTranslationsChange` was previously
  // memoized; the rest were recreated every render, needlessly re-running downstream effects).
  const onTemplateChange = useCallback(
    (next: UnifiedTemplate) => {
      setValue(unifiedTemplateField, safeJsonStringify(next), { shouldDirty: true });
    },
    [setValue, unifiedTemplateField]
  );

  const onVariablesChange = useCallback(
    (next: VariablesTable) => {
      setValue(variablesField, safeJsonStringify(next), { shouldDirty: true });
    },
    [setValue, variablesField]
  );

  const onTranslationsChange = useCallback(
    (next: UnifiedTranslations) => {
      setValue(unifiedTranslationsField, safeJsonStringify(next), { shouldDirty: true });
    },
    [setValue, unifiedTranslationsField]
  );

  const onUnifiedSubjectsChange = useCallback(
    (next: Record<string, string>) => {
      setValue(unifiedSubjectsField, safeJsonStringify(next), { shouldDirty: true });
    },
    [setValue, unifiedSubjectsField]
  );

  return (
    <div ref={containerRef} className={styles.unifiedHost}>
      <TabNav>
        <TabNavItem
          isActive={activeTab === 'template'}
          onClick={() => {
            setActiveTab('template');
          }}
        >
          {t('connector_details.unified_editor.tab_template')}
        </TabNavItem>
        <TabNavItem
          isActive={activeTab === 'variables'}
          onClick={() => {
            setActiveTab('variables');
          }}
        >
          {t('connector_details.unified_editor.tab_variables')}
        </TabNavItem>
        <TabNavItem
          isActive={activeTab === 'localizations'}
          onClick={() => {
            setActiveTab('localizations');
          }}
        >
          {t('connector_details.unified_editor.tab_localizations')}
        </TabNavItem>
      </TabNav>
      {activeTab === 'template' && (
        <UnifiedTemplateTab
          kind={kind}
          template={template}
          variables={variables}
          translations={translations}
          dummyPayload={dummyPayload}
          unifiedSubjects={unifiedSubjects}
          connectorFactoryId={connectorFactoryId}
          formItems={formItems}
          compiledDeliveries={compiled.rows.deliveries}
          compiledTranslations={compiled.translations}
          onTemplateChange={onTemplateChange}
          onUnifiedSubjectsChange={onUnifiedSubjectsChange}
          onParseError={setParseError}
        />
      )}
      {activeTab === 'variables' && (
        <UnifiedVariablesTab variables={variables} onChange={onVariablesChange} />
      )}
      {activeTab === 'localizations' && (
        <UnifiedLocalizationsTab translations={translations} onChange={onTranslationsChange} />
      )}
    </div>
  );
}

export default UnifiedTemplateEditor;
