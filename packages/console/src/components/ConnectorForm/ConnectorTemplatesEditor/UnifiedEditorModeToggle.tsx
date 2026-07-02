import { type ConnectorConfigFormItem, type ConnectorType } from '@logto/connector-kit';
import { type ReactNode, useEffect, useRef } from 'react';
import { useFormContext } from 'react-hook-form';

import type { ConnectorFormType } from '@/types/connector';

import UnifiedTemplateEditor from './UnifiedTemplateEditor';
import {
  seedUnifiedFromClassic,
  unifiedConnectorFactoryIds,
  kindForConnectorType,
  type EmailCompiledRow,
  type UnifiedTemplate,
  type UnifiedTranslations,
} from './unified';
import { safeJsonParse, safeJsonStringify } from './utils';

type Props = {
  /** The `templates`/`deliveries` form item this editor is rendered for. */
  readonly formItem: ConnectorConfigFormItem;
  /** The owning connector's type; retained for the {@link UnifiedTemplateEditor} prop contract. */
  readonly connectorType: ConnectorType;
  /** The connector factory id (e.g. `mailgun-email`); gates the Unified editor. */
  readonly connectorFactoryId?: string;
  /** The list of all form items in the configuration. */
  readonly formItems?: ConnectorConfigFormItem[];
  /** The classic editor content (rendered only when the connector is not allowlisted). */
  readonly children: ReactNode;
};

// A flat translation dictionary mirror type, re-declared here to avoid importing the host's private
// `TranslationMap` alias.
type TranslationMap = Record<string, Record<string, string>>;

const hasClassicData = (formItem: ConnectorConfigFormItem, raw: unknown): boolean => {
  if (formItem.key === 'deliveries') {
    const parsed = safeJsonParse<Record<string, unknown>>(raw);

    return Boolean(parsed && Object.keys(parsed).length > 0);
  }

  const parsed = safeJsonParse<unknown[]>(raw);

  return Array.isArray(parsed) && parsed.length > 0;
};

const hasUnifiedData = (
  templateRaw: unknown,
  subjectsRaw: unknown,
  translationsRaw: unknown
): boolean => {
  const template = safeJsonParse<UnifiedTemplate>(templateRaw);
  const subjects = safeJsonParse<Record<string, string>>(subjectsRaw);

  if (
    Object.values(template ?? {}).some((value) => typeof value === 'string' && value.length > 0) ||
    Object.values(subjects ?? {}).some((value) => typeof value === 'string' && value.length > 0)
  ) {
    return true;
  }

  const translations = safeJsonParse<UnifiedTranslations>(translationsRaw);

  return Object.values(translations ?? {}).some((dictionary) => Object.keys(dictionary).length > 0);
};

/**
 * The Unified editor gate for Mailgun. For allowlisted connectors (Mailgun only) it always renders
 * the {@link UnifiedTemplateEditor} and never the classic per-type children. On first mount, if the
 * connector still carries classic `templates`/`deliveries` data and has no unified data yet, it
 * best-effort seeds the unified fields from the classic rows.
 *
 * Non-allowlisted connectors pass through to the classic `children` unchanged.
 */
function UnifiedEditorModeToggle({
  formItem,
  connectorType,
  connectorFactoryId,
  formItems,
  children,
}: Props) {
  const { getValues, setValue } = useFormContext<ConnectorFormType>();
  const seedAttemptedRef = useRef(false);

  const isUnifiedConnector =
    connectorFactoryId !== undefined && unifiedConnectorFactoryIds.has(connectorFactoryId);

  useEffect(() => {
    if (!isUnifiedConnector || seedAttemptedRef.current) {
      return;
    }

    // eslint-disable-next-line @silverhand/fp/no-mutation
    seedAttemptedRef.current = true;

    const runSeeding = () => {
      const templateRaw = getValues('formConfig.unifiedTemplate');
      const subjectsRaw = getValues('formConfig.unifiedSubjects');
      const translationsRaw = getValues('formConfig.unifiedTranslations');
      const classicRowsRaw = getValues(`formConfig.${formItem.key}` as const);

      if (
        hasUnifiedData(templateRaw, subjectsRaw, translationsRaw) ||
        !hasClassicData(formItem, classicRowsRaw)
      ) {
        // Existing unified configs (or already-empty classic configs) need no seeding. Still persist
        // the mode marker so legacy saved configs that read `templateEditorMode` stay consistent.
        setValue('formConfig.templateEditorMode', safeJsonStringify('unified'), {
          shouldDirty: false,
        });

        return;
      }

      const classicTranslations =
        safeJsonParse<TranslationMap>(getValues('formConfig.translations')) ?? {};

      const getNormalizedDeliveries = (): Record<string, EmailCompiledRow> => {
        if (formItem.key === 'deliveries') {
          return safeJsonParse<Record<string, EmailCompiledRow>>(classicRowsRaw) ?? {};
        }

        const templatesArray = safeJsonParse<Array<Record<string, unknown>>>(classicRowsRaw) ?? [];

        return templatesArray.reduce<Record<string, EmailCompiledRow>>((accumulator, item) => {
          const usageType = String(item.usageType || '');

          if (!usageType) {
            return accumulator;
          }

          return {
            ...accumulator,
            [usageType]: {
              subject: typeof item.subject === 'string' ? item.subject : undefined,
              html:
                typeof item.html === 'string'
                  ? item.html
                  : typeof item.content === 'string'
                    ? item.content
                    : '',
              text: typeof item.text === 'string' ? item.text : undefined,
            },
          };
        }, {});
      };

      const normalizedDeliveries = getNormalizedDeliveries();

      const seed = seedUnifiedFromClassic(
        {
          kind: kindForConnectorType(connectorType),
          deliveries: normalizedDeliveries,
        },
        classicTranslations
      );

      setValue('formConfig.unifiedTemplate', safeJsonStringify(seed.template), {
        shouldDirty: false,
      });
      setValue('formConfig.variables', safeJsonStringify(seed.variables), { shouldDirty: false });
      setValue('formConfig.unifiedTranslations', safeJsonStringify(seed.translations), {
        shouldDirty: false,
      });
      setValue('formConfig.unifiedSubjects', safeJsonStringify(seed.unifiedSubjects ?? {}), {
        shouldDirty: false,
      });
      setValue('formConfig.templateEditorMode', safeJsonStringify('unified'), {
        shouldDirty: false,
      });
    };

    // Defer seeding so sibling `useWatch` probes (and the unified editor itself) have subscribed
    // before the form values are mutated. This avoids race conditions during the initial mount.
    const timeoutId = setTimeout(runSeeding, 0);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [isUnifiedConnector, formItem, connectorType, getValues, setValue]);

  if (!isUnifiedConnector) {
    return children;
  }

  return (
    <UnifiedTemplateEditor
      connectorType={connectorType}
      connectorFactoryId={connectorFactoryId}
      formItems={formItems}
    />
  );
}

export default UnifiedEditorModeToggle;
