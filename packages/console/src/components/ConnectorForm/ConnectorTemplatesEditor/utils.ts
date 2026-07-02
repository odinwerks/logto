import { TemplateType } from '@logto/connector-kit';
import { isLanguageTag, type LanguageTag } from '@logto/language-kit';
import { deduplicate } from '@silverhand/essentials';

import { safeParseJson } from '@/utils/json';

import { isTemplateFilled, type ConnectorTemplateMode } from './mode';

/**
 * The list of every usage type Logto supports, derived from the {@link TemplateType} enum so future
 * additions are surfaced automatically. Because `TemplateType` is a string enum (values equal
 * their keys, no numeric reverse mappings), `Object.values` yields exactly the usage-type strings.
 */
const allTemplateUsageTypes: readonly string[] = Object.values(TemplateType);

/**
 * Returns a rows array guaranteed to contain an entry for every {@link TemplateType}, in a stable
 * canonical order, by appending an empty row (built by `buildEmptyRow`) for any missing usage type.
 *
 * Existing rows are preserved (first occurrence wins on duplicate usage types), reordered to
 * follow the canonical {@link allTemplateUsageTypes} order; any custom usage type not in the enum
 * is appended at the end preserving first-seen order. Synthetic empty rows are display-only — they
 * are only persisted to the form field when the user edits one of their fields (see the host's
 * `updateTemplateField` write-back), so existing configs are never polluted with unused types.
 *
 * This lets the editor surface every supported delivery template regardless of which subset the
 * connector's config currently defines.
 *
 * @param rows The parsed template rows (any provider shape, each carrying a `usageType`).
 * @param buildEmptyRow Builds a provider-appropriate empty row for a missing usage type.
 */
export const ensureAllTemplateTypes = <T extends { usageType: string }>(
  rows: readonly T[],
  buildEmptyRow: (usageType: string) => T
): T[] => {
  const existing = new Map<string, T>();

  for (const row of rows) {
    if (typeof row.usageType === 'string' && !existing.has(row.usageType)) {
      existing.set(row.usageType, row);
    }
  }

  const seen = new Set<string>();

  // Canonical rows: every supported type, reusing the configured row where present (first wins on
  // duplicates) or a freshly-built empty row otherwise.
  const canonical = allTemplateUsageTypes.map((usageType) => {
    const row = existing.get(usageType) ?? buildEmptyRow(usageType);

    seen.add(usageType);

    return row;
  });

  // Custom (non-enum) usage types the connector defined, appended in first-seen order so
  // provider-specific templates are never dropped.
  const custom = rows.filter((row) => {
    if (typeof row.usageType !== 'string' || seen.has(row.usageType)) {
      return false;
    }

    seen.add(row.usageType);

    return true;
  });

  return [...canonical, ...custom];
};

/**
 * Sorts template rows by fill status for display: filled (specific) templates first, the `Generic`
 * row next (always parked between filled-specific and empty-specific, even when the generic row
 * itself is empty), and the remaining empty templates last. Within each bucket the input order is
 * preserved (the comparator only returns `0` for same-bucket rows, and `Array.prototype.sort` is
 * stable in the engines this app targets), so the canonical order from {@link ensureAllTemplateTypes}
 * holds inside every bucket.
 *
 * A row is "filled" when at least one of its editable fields for `mode` is non-empty (see
 * {@link isTemplateFilled}); `Generic` is matched by its `usageType` (`TemplateType.Generic`, the
 * string `'Generic'`).
 *
 * Returns a new array; the input is not mutated.
 *
 * @param templates The display rows (any provider shape, each carrying a `usageType`).
 * @param mode The editor mode for the connector (drives which fields count as "filled").
 */
export const sortTemplatesByFillStatus = <T extends { usageType: string }>(
  templates: readonly T[],
  mode: ConnectorTemplateMode
): T[] =>
  templates.slice().sort((left, right) => {
    const leftFilled = isTemplateFilled(left, mode);
    const rightFilled = isTemplateFilled(right, mode);
    const leftGeneric = left.usageType === 'Generic';
    const rightGeneric = right.usageType === 'Generic';

    // `Generic` always sits between filled-specific and empty-specific rows: after any filled
    // specific row, and before any empty specific row.
    if (leftGeneric && !rightGeneric) {
      return rightFilled ? 1 : -1;
    }

    if (!leftGeneric && rightGeneric) {
      return leftFilled ? -1 : 1;
    }

    if (leftFilled && !rightFilled) {
      return -1;
    }

    if (!leftFilled && rightFilled) {
      return 1;
    }

    return 0;
  });

/**
 * Matches `{{t.key}}` placeholders — with optional surrounding whitespace, mirroring the runtime
 * `replaceSendMessageHandlebars` resolver (`/{{\s*([\w.]+)\s*}}/g`) — and captures the translation
 * key, a run of word characters, dots, underscores, and dashes.
 */
const translationKeyPattern = /\{\{\s*t\.([a-zA-Z0-9_.-]+)\s*\}\}/gu;

/**
 * Extracts the unique `{{t.key}}` translation keys referenced across an array of template rows,
 * scanning each named string field, preserving first-seen order so the translations grid stays
 * stable as templates are edited. Keys composed solely of punctuation (no alphanumeric character)
 * are treated as malformed and ignored.
 *
 * @param templates The template rows (any provider shape).
 * @param fields The string fields to scan for `{{t.key}}` placeholders. Defaults to `['content']`
 * (SMS) so existing callers/tests are unchanged. Pass `['subject','content']` for the common email
 * shape, or `['subject','html','text']` for Mailgun `deliveries`.
 */
export const extractTranslationKeys = (
  templates: ReadonlyArray<Record<string, unknown>>,
  fields: readonly string[] = ['content']
): string[] => {
  const seen = new Set<string>();

  return templates.flatMap((template) =>
    fields.flatMap((field) => {
      const content = template[field];

      if (typeof content !== 'string' || content.length === 0) {
        return [];
      }

      const matches = [...content.matchAll(translationKeyPattern)]
        .map((match) => match[1] ?? '')
        .filter((key) => key !== '' && /[a-zA-Z0-9]/u.test(key));

      // Dedupe against `seen` while preserving first-seen order across all templates/fields.
      return matches.filter((key) => {
        if (seen.has(key)) {
          return false;
        }

        seen.add(key);

        return true;
      });
    })
  );
};

/**
 * Structural deep equality for two JSON form-field values. Both inputs are JSON strings (the shape
 * every `formConfig` JSON field is stored as); each is parsed and the resulting values are compared
 * deeply, so key order, optional-key presence, and whitespace differences do not produce false
 * inequality. Empty/invalid inputs are normalized to `undefined` so two blank fields compare equal.
 *
 * Used by the Unified editor's mirror write-back to decide whether a recompiled `deliveries`/
 * `translations` mirror differs from the form's current mirror value — comparing parsed structures
 * instead of serialized strings avoids the byte-order and optional-key mismatches that previously
 * caused spurious write-backs (and thus spurious `isDirty` flips) on load.
 */
const deepEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }

  // Primitives (including NaN-vs-NaN handled by Object.is above) and mismatched object kinds.
  if (typeof left !== typeof right) {
    return false;
  }

  // Arrays: same length and pairwise deep-equal.
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => deepEqual(item, right[index]));
  }

  // Objects: same own-key set and pairwise deep-equal values. `null` is typeof 'object' but is
  // handled by Object.is above; plain objects and class instances share key/value structure.
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }

  return false;
};

export const jsonFieldsEqual = (left: unknown, right: unknown): boolean => {
  const leftParsed = safeJsonParse(left);
  const rightParsed = safeJsonParse(right);

  return deepEqual(leftParsed, rightParsed);
};

/**
 * Best-effort `JSON.parse` that never throws: returns `undefined` for empty/whitespace-only
 * strings, non-strings, or invalid JSON. Delegates to the shared `safeParseJson` helper so error
 * handling stays identical to the rest of the console. The generic carries the caller's asserted
 * shape (a JSON form field); no structural guard applies without over-engineering.
 */
export const safeJsonParse = <T>(value: unknown): T | undefined => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return;
  }

  const result = safeParseJson(value);

  if (!result.success) {
    return;
  }

  // eslint-disable-next-line no-restricted-syntax -- the parsed value's shape is asserted by the generic caller (a JSON form field); no structural guard applies without over-engineering.
  return result.data as T;
};

/**
 * Best-effort `JSON.stringify` with the same 2-space indentation used when the form first
 * materializes JSON values (see `initFormData`). Falls back to `'{}'` for `undefined` or
 * non-serializable input (functions, BigInt, circular references) so the form field is never left
 * blank. `JSON.stringify` is typed as returning `string`, but it actually returns `undefined` for
 * some inputs, so the result is checked at runtime.
 */
export const safeJsonStringify = (value: unknown): string => {
  try {
    const result: unknown = JSON.stringify(value, null, 2);

    return typeof result === 'string' ? result : '{}';
  } catch {
    return '{}';
  }
};

/**
 * A connector's translations dictionary: `Record<LanguageTag, Record<TranslationKey, string>>`.
 */
type TranslationMap = Record<string, Record<string, string>>;

/**
 * Derives the sorted, de-duplicated list of language tags present in a translations dictionary,
 * keeping only valid {@link LanguageTag} values. Returned in a stable, sorted order so the language
 * nav and the test-template locale selector render language pills deterministically.
 *
 * `Object.keys` already yields unique keys, but `deduplicate` is applied for parity with the
 * pre-extraction implementation (no behavior change).
 */
export const deriveLanguages = (translations: TranslationMap): LanguageTag[] =>
  deduplicate(Object.keys(translations))
    .filter((languageTag): languageTag is LanguageTag => isLanguageTag(languageTag))
    .slice()
    .sort();

/**
 * Returns a shallow copy of `dictionary` with its keys sorted in ascending order. Used so the
 * serialized JSON form of a language's translations stays readable and stable across edits (no
 * key-order churn on every keystroke).
 */
export const sortRecordKeys = <T>(dictionary: Record<string, T>): Record<string, T> =>
  Object.fromEntries(
    Object.entries(dictionary)
      .slice()
      .sort(([left], [right]) => left.localeCompare(right))
  );

/**
 * Serializes a language's translation dictionary into readable, stable JSON (2-space indentation,
 * keys sorted alphabetically). Mirrors the indentation used when the form first materializes JSON
 * values so round-tripping Form ↔ JSON stays diff-free for already-sorted dictionaries. Falls back
 * to `'{}'` for a non-serializable input so the JSON editor always has valid content to display.
 */
export const serializeTranslations = (dictionary: Record<string, string>): string => {
  try {
    const result: unknown = JSON.stringify(sortRecordKeys(dictionary), null, 2);

    return typeof result === 'string' ? result : '{}';
  } catch {
    return '{}';
  }
};

/**
 * The result of parsing pasted/edited JSON for a language's translations. On success, `data` is a
 * flat `string` → `string` map; on failure, `errorKey` selects the user-facing validation message.
 */
export type TranslationsParseResult =
  | { readonly success: true; readonly data: Record<string, string> }
  | {
      readonly success: false;
      readonly errorKey:
        | 'invalid_json_format'
        | 'json_must_be_object'
        | 'json_values_must_be_strings';
    };

/**
 * Narrows a parsed JSON value to a plain object (`Record<string, unknown>`). Rejects `null`,
 * arrays, and non-objects so `Object.entries` is safe to call on the narrowed value. Defined as a
 * type guard (rather than a cast) so the rest of {@link parseTranslationsJson} (and the unified
 * per-type table parser in `./unified/utils.ts`) stays type-safe without `as`.
 *
 * Exported so the unified editor's per-type table JSON parser (`parsePerTypeTableJson`) reuses the
 * same narrowing instead of re-declaring it.
 */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parses pasted/edited JSON for a language's translations into a flat `string` → `string` map.
 * Validation rules (each maps to a user-facing error message via {@link TranslationsParseResult}):
 * - Empty/whitespace text is valid and yields `{}` (so opening JSON mode on an empty language, or
 *   clearing the editor, never wipes existing keys on merge).
 * - The top-level value must be a plain object — arrays, primitives, and `null` are rejected
 *   (`json_must_be_object`), since a language's translations is always a dictionary.
 * - Every value must be a string — numbers, booleans, `null`, nested objects, and arrays are
 *   rejected (`json_values_must_be_strings`), since `getLocalizedPayload`/the connector send path
 *   reads each value as a string.
 * - Empty-string keys are skipped (a defensive no-op; `JSON.stringify` of a draft never emits one,
 *   but hand-edited JSON might).
 *
 * Uses the shared {@link safeParseJson} helper (which never throws) and a functional build, so no
 * `let`/reassignment is needed.
 */
export const parseTranslationsJson = (text: string): TranslationsParseResult => {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return { success: true, data: {} };
  }

  const parseResult = safeParseJson(trimmed);

  if (!parseResult.success) {
    return { success: false, errorKey: 'invalid_json_format' };
  }

  if (!isPlainObject(parseResult.data)) {
    return { success: false, errorKey: 'json_must_be_object' };
  }

  // Drop empty-string keys, then keep only the string-valued entries. If the two lengths differ, a
  // value was not a string → reject. Splitting validate (length compare) from build (the predicate
  // filter) keeps the build type-safe (`[string, string][]`) without a cast.
  const entries = Object.entries(parseResult.data).filter(([key]) => key.length > 0);
  const stringEntries = entries.filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  );

  if (stringEntries.length !== entries.length) {
    return { success: false, errorKey: 'json_values_must_be_strings' };
  }

  return { success: true, data: Object.fromEntries(stringEntries) };
};

/**
 * Per-key merge of a parsed JSON dictionary into the current draft: parsed values override existing
 * keys, and unmentioned draft keys are preserved. Returns a new object; neither input is mutated.
 * Used when switching JSON → Form or when applying from JSON mode, so pasted JSON can extend an
 * existing language without losing keys that aren't mentioned in the JSON.
 */
export const mergeTranslations = (
  current: Record<string, string>,
  parsed: Record<string, string>
): Record<string, string> => ({ ...current, ...parsed });
