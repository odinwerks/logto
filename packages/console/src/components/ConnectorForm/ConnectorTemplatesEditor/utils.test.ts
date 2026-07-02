/* eslint-disable max-lines */
import { TemplateType } from '@logto/connector-kit';

import {
  ensureAllTemplateTypes,
  extractTranslationKeys,
  jsonFieldsEqual,
  mergeTranslations,
  parseTranslationsJson,
  safeJsonParse,
  safeJsonStringify,
  serializeTranslations,
  sortRecordKeys,
  sortTemplatesByFillStatus,
} from './utils';

// Provider-agnostic empty-row factories shared across the `ensureAllTemplateTypes` cases.
const buildSmsRow = (usageType: string) => ({ usageType, content: '' });
const buildEmailRow = (usageType: string) => ({ usageType, subject: '', content: '' });
// SMS row factory with an explicit `content`, used by the `sortTemplatesByFillStatus` cases.
const smsRow = (usageType: string, content: string) => ({ usageType, content });

describe('extractTranslationKeys', () => {
  it('collects unique keys preserving first-seen order', () => {
    const templates = [
      { content: 'Hello {{t.greeting}}, your code is {{code}}' },
      { content: '{{t.greeting}} — {{t.farewell}}' },
    ];

    expect(extractTranslationKeys(templates)).toEqual(['greeting', 'farewell']);
  });

  it('ignores non-`t` handlebars such as `{{code}}`', () => {
    expect(extractTranslationKeys([{ content: '{{code}} {{t.x}}' }])).toEqual(['x']);
  });

  it('tolerates whitespace around the handlebars (matches the runtime resolver)', () => {
    expect(extractTranslationKeys([{ content: '{{ t.greeting }}' }])).toEqual(['greeting']);
  });

  it('ignores malformed keys with no alphanumeric characters', () => {
    expect(extractTranslationKeys([{ content: '{{t.}} {{t..}} {{t.__}} {{t.real}}' }])).toEqual([
      'real',
    ]);
  });

  it('handles missing, empty, or non-string content', () => {
    expect(
      extractTranslationKeys([
        { content: undefined },
        { content: '' },
        // A template with no `content` field at all — `content` is optional, so this is valid.
        {},
        { content: '{{t.only}}' },
      ])
    ).toEqual(['only']);
  });

  it('deduplicates keys across templates', () => {
    expect(
      extractTranslationKeys([{ content: '{{t.one}}' }, { content: '{{t.one}} {{t.two}}' }])
    ).toEqual(['one', 'two']);
  });

  it('defaults to the `content` field (SMS) when no fields are passed', () => {
    const templates = [{ subject: '{{t.subject}}', content: '{{t.body}}' }];

    expect(extractTranslationKeys(templates)).toEqual(['body']);
  });

  it('scans multiple named fields (email subject + content)', () => {
    const templates = [
      {
        usageType: 'SignIn',
        subject: 'Welcome {{t.greeting}}',
        content: 'Code {{code}} {{t.body}}',
      },
      { usageType: 'Register', subject: 'Hi {{t.greeting}}', content: '{{t.body}}' },
    ];

    expect(extractTranslationKeys(templates, ['subject', 'content'])).toEqual(['greeting', 'body']);
  });

  it('scans html/text/subject fields (Mailgun deliveries)', () => {
    const templates = [
      {
        usageType: 'SignIn',
        subject: 'Verify {{t.subject_key}}',
        html: '<p>{{t.html_key}}</p>',
        text: '{{t.text_key}}',
      },
    ];

    expect(extractTranslationKeys(templates, ['subject', 'html', 'text'])).toEqual([
      'subject_key',
      'html_key',
      'text_key',
    ]);
  });

  it('skips a named field that is missing or non-string', () => {
    const templates = [
      { usageType: 'SignIn', subject: '{{t.in_subject}}', content: undefined },
      { usageType: 'Register', subject: 42, content: '{{t.in_content}}' },
    ];

    expect(extractTranslationKeys(templates, ['subject', 'content'])).toEqual([
      'in_subject',
      'in_content',
    ]);
  });

  it('returns an empty list for the alias mode (no fields)', () => {
    const templates = [{ usageType: 'SignIn', templateAlias: 'sign-in-template' }];

    expect(extractTranslationKeys(templates, [])).toEqual([]);
  });
});

describe('safeJsonParse', () => {
  it('parses valid JSON objects', () => {
    expect(safeJsonParse<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses valid JSON arrays', () => {
    expect(safeJsonParse<number[]>('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('returns undefined for invalid JSON', () => {
    expect(safeJsonParse('{not json')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(safeJsonParse('')).toBeUndefined();
  });

  it('returns undefined for a whitespace-only string', () => {
    expect(safeJsonParse('   ')).toBeUndefined();
  });

  it('returns undefined for non-string input', () => {
    const undefinedValue: unknown = undefined;

    expect(safeJsonParse(123)).toBeUndefined();
    expect(safeJsonParse(null)).toBeUndefined();
    expect(safeJsonParse(undefinedValue)).toBeUndefined();
  });
});

describe('safeJsonStringify', () => {
  it('stringifies a plain object (round-trips through JSON.parse)', () => {
    expect(JSON.parse(safeJsonStringify({ a: 1 }))).toEqual({ a: 1 });
  });

  it('stringifies an array', () => {
    expect(JSON.parse(safeJsonStringify([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it('returns "{}" for undefined', () => {
    const undefinedValue: unknown = undefined;

    expect(safeJsonStringify(undefinedValue)).toBe('{}');
  });

  it('returns "{}" for a non-serializable value (BigInt)', () => {
    expect(safeJsonStringify({ a: 1n })).toBe('{}');
  });
});

describe('ensureAllTemplateTypes', () => {
  it('appends an empty row for every supported template type not already present', () => {
    const rows = [
      { usageType: TemplateType.SignIn, content: 'Welcome' },
      { usageType: TemplateType.Generic, content: 'Generic' },
    ];

    const result = ensureAllTemplateTypes(rows, buildSmsRow);
    const usageTypes = result.map(({ usageType }) => usageType);

    // Every supported type is present, including the ones the input did not define.
    for (const type of Object.values(TemplateType)) {
      expect(usageTypes).toContain(type);
    }
  });

  it('preserves existing rows verbatim (config values are not wiped)', () => {
    const signIn = { usageType: TemplateType.SignIn, content: 'Welcome' };

    const result = ensureAllTemplateTypes([signIn], buildSmsRow);
    const found = result.find(({ usageType }) => usageType === TemplateType.SignIn);

    expect(found).toBe(signIn);
  });

  it('orders rows by the canonical TemplateType order (existing and appended alike)', () => {
    // Input deliberately out of canonical order.
    const rows = [
      { usageType: TemplateType.Generic, content: 'Generic' },
      { usageType: TemplateType.Register, content: 'Register' },
      { usageType: TemplateType.SignIn, content: 'SignIn' },
    ];

    const result = ensureAllTemplateTypes(rows, buildSmsRow);
    const canonical = Object.values(TemplateType);

    // The first result entries match the canonical enum order (SignIn before Register before
    // OrganizationInvitation before Generic, …); the three configured values interleave correctly.
    expect(result.slice(0, canonical.length).map(({ usageType }) => usageType)).toEqual(canonical);
  });

  it('appends custom (non-enum) usage types at the end, preserving first-seen order', () => {
    const rows = [
      { usageType: TemplateType.SignIn, content: 'SignIn' },
      { usageType: 'CustomTwo', content: 'two' },
      { usageType: 'CustomOne', content: 'one' },
    ];

    const result = ensureAllTemplateTypes(rows, buildSmsRow);
    const usageTypes = result.map(({ usageType }) => usageType);

    // All enum types come first, then the custom types in first-seen order.
    expect(usageTypes.slice(0, Object.values(TemplateType).length)).toEqual(
      Object.values(TemplateType)
    );
    expect(usageTypes.slice(-2)).toEqual(['CustomTwo', 'CustomOne']);
  });

  it('builds empty rows for missing types via the provided factory', () => {
    const result = ensureAllTemplateTypes([], buildSmsRow);
    const register = result.find(({ usageType }) => usageType === TemplateType.Register);

    expect(register).toEqual({ usageType: TemplateType.Register, content: '' });
  });

  it('deduplicates rows sharing a usage type (first occurrence wins)', () => {
    const first = { usageType: TemplateType.SignIn, content: 'first' };
    const second = { usageType: TemplateType.SignIn, content: 'second' };

    const result = ensureAllTemplateTypes([first, second], buildSmsRow);
    const signInRows = result.filter(({ usageType }) => usageType === TemplateType.SignIn);

    expect(signInRows).toEqual([first]);
  });

  it('returns the full canonical set for an empty input', () => {
    const result = ensureAllTemplateTypes([], buildSmsRow);

    expect(result.map(({ usageType }) => usageType)).toEqual(Object.values(TemplateType));
    expect(result.every((row) => row.content === '')).toBe(true);
  });

  it('is generic over the row shape (works for email rows with subject/content)', () => {
    const result = ensureAllTemplateTypes(
      [{ usageType: TemplateType.ForgotPassword, subject: 'Reset', content: 'Body' }],
      buildEmailRow
    );
    const signIn = result.find(({ usageType }) => usageType === TemplateType.SignIn);

    expect(signIn).toEqual({ usageType: TemplateType.SignIn, subject: '', content: '' });
  });
});

describe('sortTemplatesByFillStatus', () => {
  it('moves filled (specific) templates above empty ones, parking Generic in between', () => {
    const templates = [
      smsRow('Register', ''),
      smsRow('SignIn', 'Your code is {{code}}'),
      smsRow('ForgotPassword', ''),
      smsRow('Generic', 'Generic code {{code}}'),
    ];

    const ordered = sortTemplatesByFillStatus(templates, 'sms').map(({ usageType }) => usageType);

    // Filled-specific (SignIn) → Generic (filled, but parked between filled and empty) →
    // empty-specific (Register, ForgotPassword) in input order.
    expect(ordered).toEqual(['SignIn', 'Generic', 'Register', 'ForgotPassword']);
  });

  it('parks an empty Generic above empty-specific templates', () => {
    const templates = [
      smsRow('Register', ''),
      smsRow('SignIn', 'filled'),
      smsRow('ForgotPassword', 'filled'),
      smsRow('Generic', ''),
    ];

    const ordered = sortTemplatesByFillStatus(templates, 'sms').map(({ usageType }) => usageType);

    // Filled-specific (SignIn, ForgotPassword) → empty Generic → empty-specific (Register).
    expect(ordered).toEqual(['SignIn', 'ForgotPassword', 'Generic', 'Register']);
  });

  it('places a filled Generic after filled-specific templates (Generic is its own bucket)', () => {
    const templates = [
      smsRow('SignIn', 'a'),
      smsRow('Generic', 'filled-generic'),
      smsRow('Register', 'b'),
    ];

    const ordered = sortTemplatesByFillStatus(templates, 'sms').map(({ usageType }) => usageType);

    // Filled-specific keep input order (SignIn, Register); Generic lands after them.
    expect(ordered).toEqual(['SignIn', 'Register', 'Generic']);
  });

  it('orders Generic first when no templates are filled', () => {
    const templates = [smsRow('SignIn', ''), smsRow('Register', ''), smsRow('Generic', '')];

    const ordered = sortTemplatesByFillStatus(templates, 'sms').map(({ usageType }) => usageType);

    // No filled-specific rows, so Generic (always before empty-specific) surfaces first; the empty
    // specifics follow in input order.
    expect(ordered).toEqual(['Generic', 'SignIn', 'Register']);
  });

  it('preserves input order within the filled and empty buckets (stable sort)', () => {
    const templates = [
      smsRow('ForgotPassword', ''),
      smsRow('Register', ''),
      smsRow('SignIn', 'filled'),
      smsRow('OrganizationInvitation', 'filled'),
    ];

    const ordered = sortTemplatesByFillStatus(templates, 'sms').map(({ usageType }) => usageType);

    // Filled bucket keeps input order (SignIn, OrganizationInvitation); empty bucket keeps input
    // order (ForgotPassword, Register).
    expect(ordered).toEqual(['SignIn', 'OrganizationInvitation', 'ForgotPassword', 'Register']);
  });

  it('is mode-aware: an email-content row is filled via subject or content', () => {
    const templates = [
      { usageType: 'Register', subject: '', content: '' },
      { usageType: 'SignIn', subject: 'Hi', content: '' },
      { usageType: 'Generic', subject: '', content: '<p>generic</p>' },
    ];

    const ordered = sortTemplatesByFillStatus(templates, 'email-content').map(
      ({ usageType }) => usageType
    );

    // SignIn is filled (subject); Generic is filled but parked after filled-specific; Register
    // (empty) is last.
    expect(ordered).toEqual(['SignIn', 'Generic', 'Register']);
  });

  it('does not mutate the input array', () => {
    const templates = [
      smsRow('Register', ''),
      smsRow('SignIn', 'filled'),
      smsRow('Generic', 'filled-generic'),
    ];
    const snapshot = templates.map(({ usageType }) => usageType);

    sortTemplatesByFillStatus(templates, 'sms');

    expect(templates.map(({ usageType }) => usageType)).toEqual(snapshot);
  });
});

describe('sortRecordKeys', () => {
  it('returns a new object with keys sorted alphabetically', () => {
    expect(sortRecordKeys({ b: 1, a: 2, c: 3 })).toEqual({ a: 2, b: 1, c: 3 });
  });

  it('does not mutate the input object', () => {
    const input = { b: 1, a: 2 };

    sortRecordKeys(input);

    expect(Object.keys(input)).toEqual(['b', 'a']);
  });

  it('returns an empty object for an empty input', () => {
    expect(sortRecordKeys({})).toEqual({});
  });
});

describe('serializeTranslations', () => {
  it('pretty-prints with 2-space indentation and sorted keys', () => {
    expect(serializeTranslations({ code: '1', greeting: 'hi' })).toBe(
      ['{', '  "code": "1",', '  "greeting": "hi"', '}'].join('\n')
    );
  });

  it('sorts keys regardless of insertion order', () => {
    const fromZFirst = serializeTranslations({ zeta: '1', alpha: '2' });
    const fromAFirst = serializeTranslations({ alpha: '2', zeta: '1' });

    expect(fromZFirst).toBe(fromAFirst);
    expect(fromZFirst).toBe(['{', '  "alpha": "2",', '  "zeta": "1"', '}'].join('\n'));
  });

  it('serializes an empty dictionary as "{}"', () => {
    expect(serializeTranslations({})).toBe('{}');
  });

  it('escapes string values containing quotes without breaking JSON', () => {
    expect(JSON.parse(serializeTranslations({ greeting: 'say "hi"' }))).toEqual({
      greeting: 'say "hi"',
    });
  });
});

describe('parseTranslationsJson', () => {
  it('parses a valid flat object into a string → string map', () => {
    expect(parseTranslationsJson('{ "code": "1234", "greeting": "hi" }')).toEqual({
      success: true,
      data: { code: '1234', greeting: 'hi' },
    });
  });

  it('returns an empty map for an empty/whitespace-only string (valid)', () => {
    expect(parseTranslationsJson('')).toEqual({ success: true, data: {} });
    expect(parseTranslationsJson('   \n\t ')).toEqual({ success: true, data: {} });
  });

  it('treats an empty JSON object as valid and yields {}', () => {
    expect(parseTranslationsJson('{}')).toEqual({ success: true, data: {} });
  });

  it('reports invalid_json_format for malformed JSON', () => {
    expect(parseTranslationsJson('{not json')).toEqual({
      success: false,
      errorKey: 'invalid_json_format',
    });
    expect(parseTranslationsJson('{ "code": "1" ')).toEqual({
      success: false,
      errorKey: 'invalid_json_format',
    });
  });

  it('reports json_must_be_object for a JSON array', () => {
    expect(parseTranslationsJson('[1, 2, 3]')).toEqual({
      success: false,
      errorKey: 'json_must_be_object',
    });
  });

  it('reports json_must_be_object for a JSON primitive or null', () => {
    expect(parseTranslationsJson('"a string"')).toEqual({
      success: false,
      errorKey: 'json_must_be_object',
    });
    expect(parseTranslationsJson('42')).toEqual({
      success: false,
      errorKey: 'json_must_be_object',
    });
    expect(parseTranslationsJson('true')).toEqual({
      success: false,
      errorKey: 'json_must_be_object',
    });
    expect(parseTranslationsJson('null')).toEqual({
      success: false,
      errorKey: 'json_must_be_object',
    });
  });

  it('reports json_values_must_be_strings for non-string values', () => {
    expect(parseTranslationsJson('{ "code": 1234 }')).toEqual({
      success: false,
      errorKey: 'json_values_must_be_strings',
    });
    expect(parseTranslationsJson('{ "flag": true }')).toEqual({
      success: false,
      errorKey: 'json_values_must_be_strings',
    });
    expect(parseTranslationsJson('{ "x": null }')).toEqual({
      success: false,
      errorKey: 'json_values_must_be_strings',
    });
    expect(parseTranslationsJson('{ "nested": { "a": 1 } }')).toEqual({
      success: false,
      errorKey: 'json_values_must_be_strings',
    });
    expect(parseTranslationsJson('{ "list": [1, 2] }')).toEqual({
      success: false,
      errorKey: 'json_values_must_be_strings',
    });
  });

  it('skips empty-string keys silently', () => {
    expect(parseTranslationsJson('{ "": "x", "code": "1" }')).toEqual({
      success: true,
      data: { code: '1' },
    });
  });
});

describe('mergeTranslations', () => {
  it('lets parsed values override existing keys', () => {
    expect(mergeTranslations({ a: '1', b: '2' }, { b: 'updated' })).toEqual({
      a: '1',
      b: 'updated',
    });
  });

  it('preserves draft keys that are not mentioned in the parsed JSON', () => {
    expect(mergeTranslations({ a: '1' }, { b: '2' })).toEqual({ a: '1', b: '2' });
  });

  it('returns a new object (does not mutate inputs)', () => {
    const current = { a: '1' };
    const parsed = { b: '2' };
    const merged = mergeTranslations(current, parsed);

    expect(merged).toEqual({ a: '1', b: '2' });
    expect(current).toEqual({ a: '1' });
    expect(parsed).toEqual({ b: '2' });
  });

  it('an empty parsed map is a no-op (preserves the current dictionary)', () => {
    expect(mergeTranslations({ a: '1' }, {})).toEqual({ a: '1' });
  });
});

describe('jsonFieldsEqual', () => {
  it('treats two structurally-equal JSON strings as equal regardless of key order', () => {
    const left = JSON.stringify({ b: '2', a: '1' });
    const right = JSON.stringify({ a: '1', b: '2' });

    expect(jsonFieldsEqual(left, right)).toBe(true);
  });

  it('treats two structurally-equal JSON strings as equal regardless of indentation', () => {
    const compact = JSON.stringify({ Generic: { html: 'hi', subject: 's' } });
    const pretty = JSON.stringify({ Generic: { html: 'hi', subject: 's' } }, null, 2);

    expect(jsonFieldsEqual(compact, pretty)).toBe(true);
  });

  it('treats optional-key presence differences as inequality when the extra key has a value', () => {
    const withSubject = JSON.stringify({ Generic: { html: 'hi', subject: 's' } });
    const withoutSubject = JSON.stringify({ Generic: { html: 'hi' } });

    expect(jsonFieldsEqual(withSubject, withoutSubject)).toBe(false);
  });

  it('detects a subset mismatch (expanded delivery types vs a single saved row)', () => {
    const expanded = JSON.stringify({
      SignIn: { html: 'hi' },
      Register: { html: 'hi' },
      Generic: { html: 'hi' },
    });
    const subset = JSON.stringify({ Generic: { html: 'hi' } });

    expect(jsonFieldsEqual(expanded, subset)).toBe(false);
  });

  it('treats empty/blank/invalid inputs as equal to each other', () => {
    expect(jsonFieldsEqual('', '')).toBe(true);
    expect(jsonFieldsEqual('   ', '')).toBe(true);
    expect(jsonFieldsEqual('{ not json', '{ also not json')).toBe(true);
  });

  it('treats an empty object as unequal to a non-empty object', () => {
    expect(jsonFieldsEqual('{}', JSON.stringify({ a: '1' }))).toBe(false);
  });

  it('compares nested arrays element-wise', () => {
    expect(
      jsonFieldsEqual(
        JSON.stringify([{ usageType: 'SignIn' }]),
        JSON.stringify([{ usageType: 'SignIn' }])
      )
    ).toBe(true);
    expect(
      jsonFieldsEqual(
        JSON.stringify([{ usageType: 'SignIn' }]),
        JSON.stringify([{ usageType: 'Register' }])
      )
    ).toBe(false);
  });

  it('treats non-string inputs (e.g. null) as blank', () => {
    expect(jsonFieldsEqual(null, null)).toBe(true);
    expect(jsonFieldsEqual(null, '{}')).toBe(false);
  });
});
/* eslint-enable max-lines */
