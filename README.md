# Logto Blacktop

[Logto](https://github.com/logto-io/logto) is an amazing platform. OIDC/OAuth 2.1/SAML, multi-tenancy, enterprise SSO, RBAC, all out of the box. I love it.

I wanted to add more features. So I did.

Everything added in this fork gets submitted back to upstream Logto as a PR (Unless it is something I KNOW they will not pull into their repo). They merge it if they want to. This fork has stuff I need, you may need the same things too, and hence I made the fork public, also to serve features of this components-kit/starter-app amalgamation https://github.com/odinwerks/logto-components-next better:

I called it Blacktop because Toyota's 4A-GE Blacktop is a cool motor. And I needed a name to differentiate my fork version from the official one.

---

## Database Migrations

Because this fork cherry-picks features from different branches, some alterations reference columns that do not exist yet in your database. The Logto CLI tracks deployments by timestamp and will skip any alteration older than the current state, even if the column is missing.

**You must run the alteration deploy command after every rebuild:**

```bash
docker compose run --rm --entrypoint "" logto npx @logto/cli db alteration deploy latest
```

If the CLI says "Found 0 alteration to deploy" but Logto crashes with a "column does not exist" error, check which columns are missing and apply them manually:

```bash
docker compose exec postgres psql -U postgres -d logto -c "\d users"
docker compose exec postgres psql -U postgres -d logto -c "\d sign_in_experiences"
docker compose exec postgres psql -U postgres -d logto -c "\d oidc_session_extensions"
```

You can also list what the CLI thinks is pending:

```bash
docker compose run --rm --entrypoint "" logto npx @logto/cli db alteration list latest
docker compose run --rm --entrypoint "" logto npx @logto/cli db alteration list next
```

The SQL for each Blacktop alteration is in `packages/schemas/alterations/`. Each file is a plain TypeScript module with an `up` function containing the exact SQL. Read the file, run the SQL manually if needed, then restart.

```bash
docker compose restart logto
```

---

## Community PRs

These are PRs submitted to `logto-io/logto` by community members. They are merged into Logto Blacktop and ready to use. Some have since been accepted by upstream Logto as well (marked with **[Merged!]**).

### ~~[#8728](https://github.com/logto-io/logto/pull/8728)~~ **[Merged!]**, ~~[#8729](https://github.com/logto-io/logto/pull/8729)~~ **[Merged!]**, [#8731](https://github.com/logto-io/logto/pull/8731) - `isCurrent` flag on session listings

by [@simeng-li](https://github.com/simeng-li)

Three stacked PRs that together add an `isCurrent` boolean to the `GET /api/my-account/sessions` response, so clients can tell which session in the list is the one making the request (i.e. "this device").

- **#8728** plumbs the OIDC session UID from the access token through `koaOidcAuth` into `ctx.auth.sessionUid`. Small groundwork change, no consumer yet. **[Merged!]**
- **#8729** uses that `sessionUid` to tag the matching entry in `GET /api/my-account/sessions` with `isCurrent: true` (others get `false`). Initially behind a dev-features flag. **[Merged!]**
- **#8731** removes the dev-features gate and ships `isCurrent` unconditionally to production. Also updates the OpenAPI docs.
- **#8760** edge case integration tests (revoke-own, two-perspectives, admin-endpoint) applied as-is from upstream. The fork's existing `isCurrent` tests already use `devFeatureTest.it()`, matching the upstream pattern.

### [#8752](https://github.com/logto-io/logto/pull/8752) - `userIds` in organization membership webhooks

by [@chiche84](https://github.com/chiche84)

When users are added to or removed from an organization, the `Organization.Membership.Updated` webhook payload now includes a `userIds` array. Previously the payload only contained the organization object, forcing consumers to make a follow-up API call to find out who was affected. Two lines of code, zero risk.

### [#8747](https://github.com/logto-io/logto/pull/8747) - Email connector URL detection fix

by [@aayushbaluni](https://github.com/aayushbaluni)

The URL validation regex in the email connector was flagging company names like `Company p.s.a.` as URLs, blocking valid `companyInformation` config values. The fix requires an explicit `https://` scheme or a `www.` prefix before treating a string as a URL. Dotted abbreviations no longer trigger false positives.

### [#8643](https://github.com/logto-io/logto/pull/8643) - Password expiration

by [@tevass](https://github.com/tevass)

Full end-to-end password expiration feature. Configure a maximum password age and an optional reminder window in the Admin Console. When a user's password is close to expiring, the sign-in experience shows a reminder modal with the option to reset now or continue. When expired, it blocks sign-in and forces a reset.

- Admin Console controls under Security > Password Policy: enable expiration, set validity period in days, set reminder period in days
- "Expire password" button on the user detail page to manually force a reset on next sign-in
- New API: `PATCH /admin/users/:userId` accepts `isPasswordExpired: true`
- DB: `password_expiration` policy column on `sign_in_experiences`, `is_password_expired` flag on `users`, `password_updated_at` on `users`
- i18n in 20 languages (ar, cs, de, en, es, fr, it, ja, ko, pl, pt-br, pt-pt, ru, th, tr, uk, zh-cn, zh-hk, zh-tw)
- All review comments addressed. gao-sun and wangsijie reacted with hearts on the PR.

---

## Original Features

### Unified template editor (Mailgun only)

This fork includes a unified template editor for the Mailgun email connector. Instead of maintaining nine separate HTML templates for every Logto template type, you write one HTML body and mark the lines that differ per type with `<If type="SignIn">...</If>` blocks. The console compiles that single body into per type `deliveries` rows at save time.

The editor has three tabs: Template, Variables, and Localizations. Template holds the shared HTML body. Variables holds per type placeholders that get inlined as `{{varName}}`. Localizations holds a flat dictionary of `{{t.key}}` translations that get resolved through Logto's locale fallback chain.

This approach keeps localization keys verbatim. Earlier attempts used a variable builder that derived names from common suffixes of translation keys, but it silently renamed keys and broke round trip fidelity, so this fork uses explicit `<If>` blocks instead.

Currently the editor is gated to the Mailgun connector only because Mailgun uses a `deliveries` record shape and this editor was built specifically for that runtime model. SMS connectors and other email connectors keep the classic per type editor.

It was built this way because I maintain many per type Mailgun templates and I wanted one place to edit shared structure without copy pasting HTML across nine rows.

For more on how the locale reaches the connector and how the same localization machinery works for SMS connectors, see [Localization and locale passthrough](#localization-and-locale-passthrough). Connector-specific details are in [`packages/connectors/connector-mailgun/README.md`](packages/connectors/connector-mailgun/README.md) and [`packages/connectors/connector-ubill-sms/README.md`](packages/connectors/connector-ubill-sms/README.md).

### Localization and locale passthrough

Logto Blacktop passes the end-user's locale through the entire verification-code stack so connectors can resolve translated content themselves.

#### Overview

1. The client or admin dashboard sends `body.locale` on the verification-code request.
2. Logto core passes that locale verbatim into the connector's `sendMessage` payload as `payload.locale`.
3. The connector resolves the best matching template / translation dictionary and renders the message.

Region tags are preserved. `ka-GE` stays `ka-GE`; it is not collapsed to `ka`. The connector is responsible for its own fallback chain, which is `ka-GE → ka → en → first available`. Collapsing `ka-GE` to `ka` would break lookups when translations are stored under region-specific keys.

#### API routes that accept `body.locale`

- `POST /api/verifications/verification-code`
- `POST /api/experience/verification/verification-code`
- `POST /api/me/verification-codes`

#### How connectors resolve locale

Connectors use `getLocalizedPayload(payload, config.translations)` from `@logto/connector-kit`. The helper:

- Reads `payload.locale`.
- Walks the fallback chain `exact locale → parent language tag → en → first available`.
- Returns a new payload with `payload.t` set to the resolved dictionary, or returns the payload unchanged if no translations are configured.

Template content then references keys with `{{t.key}}` placeholders, resolved by `replaceSendMessageHandlebars`.

#### Simplified: adding localization to an SMS connector

This is the smallest viable localization setup, modeled by `connector-ubill-sms`.

1. Add `translations` to the config guard:

```ts
translations: z.record(z.record(z.string())).optional(),
```

2. Import `getLocalizedPayload`, `replaceSendMessageHandlebars`, and `TemplateType` from `@logto/connector-kit`.

3. In `sendMessage`, find the template and resolve localized placeholders:

```ts
const template =
  config.templates.find((item) => item.usageType === type) ??
  config.templates.find((item) => item.usageType === TemplateType.Generic);

const localizedPayload = getLocalizedPayload(payload, config.translations);
const message = replaceSendMessageHandlebars(
  template.content,
  localizedPayload,
);
```

4. Add a `Generic` template so an unconfigured usage type has a fallback.

5. Add a `translations` JSON form item in `constant.ts` (optionally gated with `isDevFeature: true`):

```ts
{
  key: 'translations',
  label: 'Translations',
  type: ConnectorConfigFormItemType.Json,
  required: false,
  isDevFeature: true,
}
```

Connector-level details are in [`packages/connectors/connector-ubill-sms/README.md`](packages/connectors/connector-ubill-sms/README.md).

#### Full: adding the unified template editor to an email connector

The unified template editor is currently allowlisted to `mailgun-email`. To add it to another email connector:

1. Add the connector factory ID to `unifiedConnectorFactoryIds` in `packages/console/src/components/ConnectorForm/ConnectorTemplatesEditor/unified/types.ts`.

2. Add the runtime and editor-only fields to the connector config guard. `deliveries` and `translations` are consumed at runtime; the `unified*` fields are editor source state and are compiled into `deliveries`/`translations` by the console on save:

```ts
deliveries: z.record(templateConfigGuard),
translations: z.record(z.record(z.string())).optional(),
// Editor source fields (console-only)
unifiedTemplate: z.record(z.unknown()).optional(),
variables: z.record(z.unknown()).optional(),
unifiedTranslations: z.record(z.unknown()).optional(),
unifiedSubjects: z.record(z.unknown()).optional(),
templateEditorMode: z.string().optional(),
```

3. Implement `sendMessage` to use both DB email templates and connector-level translations:

```ts
const customTemplate = await trySafe(async () =>
  getI18nEmailTemplate?.(type, payload.locale),
);

const template = deliveries[type] ?? deliveries[TemplateType.Generic];

const localizedPayload = getLocalizedPayload(payload, translations);

const data = customTemplate
  ? getDataFromCustomTemplate(customTemplate, localizedPayload)
  : template && getDataFromDeliveryConfig(template, localizedPayload);
```

4. Make sure `getDataFromDeliveryConfig` (or equivalent) applies `replaceSendMessageHandlebars` to `subject`, `html`, and optional `text` fields.

5. Add `deliveries` and `translations` JSON form items in `constant.ts`. Mark `translations` with `isDevFeature: true` while the feature is under development. The unified editor source fields do not need their own form items — the `UnifiedTemplateEditor` component registers and manages them directly.

6. If the new connector also wants the unified editor, add its factory ID to the allowlist and make sure `kindForConnectorType` in the console returns the right `ConnectorKind`.

Connector-level details are in [`packages/connectors/connector-mailgun/README.md`](packages/connectors/connector-mailgun/README.md).

### S3 Storage Overhaul + Account API Avatar Upload

> **Upstream status:** Submitted as [PR #8801](https://github.com/logto-io/logto/pull/8801). Closed. Logto is building a similar feature internally. Rather than maintain two competing designs, I closed this PR and kept the implementation in Blacktop.

The stock Logto S3 provider only does `PutObject`. No delete, no list, no way to check if a file even exists. Every upload gets a random date-stamped path like `userId/2025/03/15/Aa1Bb2Cc/file.png` that guarantees the file is never cleaned up. Custom UI assets require Azure Functions (blob trigger + polling). No proxy routes -- you must configure `publicUrl` or expose your S3 bucket directly.

#### What changed

The S3 provider now supports all six operations: upload, delete, list (with pagination), download, copy, and file-existence checks. Upload paths are deterministic: `{tenant}/user-assets/{userId}/you.{ext}` for avatars, `{tenant}/app-assets/branding/{filename}` for logos/favicons. Same-name files atomically overwrite. Different extensions trigger cleanup of old files. No orphans.

Magic-byte image detection validates the actual file content, not the browser's claimed Content-Type (JPEG, PNG, GIF, BMP, WebP). Uploads include `?v=${Date.now()}` cache-busting. S3 ACL is configurable per-upload via `isPublic` flag (defaults to `true` for backward compatibility).

Custom UI assets are unzipped in-process via AdmZip -- no Azure Functions required. A 50MB cumulative size cap prevents zip-bomb DoS.

#### Account API: Avatar Upload

Instead of the old two-step dance (upload to `/user-assets`, then PATCH the user record), there's a single endpoint:

```
POST /api/my-account/avatar
Authorization: Bearer <access-token>
Content-Type: multipart/form-data

file: <image binary>
```

The endpoint validates the image via magic bytes, uploads to `admin/user-assets/{userId}/you.{ext}`, cleans up old avatar files with other extensions, and updates the user record. One call. One response with the updated profile and cache-busted URL.

Accepts JPEG, PNG, GIF, WebP, BMP. Maximum 20 MB. Requires `profile` scope. Requires account center `avatar` field set to `Edit`.

The old `PATCH /api/my-account` with `{ avatar: url }` still works for custom backends.

#### Proxy Routes

Uploaded files are served through Logto itself, not directly from S3.

**User avatars:**
```
GET /api/user-assets/{userId}/{filename}
```

**App assets (logos, favicons):**
```
GET /api/app-assets/{filename}
```

Public. No auth needed. Files are served with `Cross-Origin-Resource-Policy: cross-origin` so avatars embed cross-domain without extra configuration, and `Cache-Control: immutable` for performance.

#### Client integration

`POST /api/my-account/avatar` is a standard REST endpoint on the user Account API. Any client with an access token and `profile` scope can call it. No special SDK needed.

**Browser / Node.js (any JS framework)**

```ts
const token = await getAccessToken(); // your existing auth flow
const formData = new FormData();
formData.append('file', file);

const res = await fetch(`${endpoint}/api/my-account/avatar`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: formData,
});

const profile = await res.json();
// { id: "user123", name: "Jane", avatar: "https://...you.png?v=...", ... }
```

**curl (testing)**

```bash
curl -X POST https://auth.example.com/api/my-account/avatar \
  -H "Authorization: Bearer <token>" \
  -F "file=@avatar.png"
```

**Server Action (Next.js)**

FormData preserves the file binary, and server-side auth keeps the access token out of client bundles:

```ts
// logto-kit/logic/actions/avatar.ts
'use server';
import { getAccessToken } from '@logto/next/server-actions';

export async function uploadAvatar(formData: FormData): Promise<{ avatar: string }> {
  const token = await getAccessToken('<endpoint>', 'profile');
  const res = await fetch(`${process.env.ENDPOINT}/api/my-account/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  if (!res.ok) throw new Error('Upload failed');
  return res.json();
}
```

#### Why upstream's design fails self-hosters

1. **Date-stamped paths are wasteful.** Every upload creates a new S3 object. No cleanup mechanism. Over time, a single user's avatar becomes 5+ orphaned files.
2. **No proxy routes mean `publicUrl` is mandatory.** Self-hosters behind reverse proxies often don't have public S3 URLs. Blacktop's proxy routes (`/api/user-assets/`, `/api/app-assets/`) just work.
3. **Custom UI requires Azure Functions.** The zip upload goes to Azure blob storage, a trigger unzips it, polling checks completion. Impossible on self-hosted infrastructure. Blacktop's AdmZip works anywhere.
4. **No cache-busting means stale images.** Same URL after re-upload means browser serves old cached image.

### Session Last Active Tracking + Heartbeat API (built on top of PRs #8728, #8729, and #8731.)


> **Upstream status:** Submitted as [PR #8748](https://github.com/logto-io/logto/pull/8748). Logto maintainer @simeng-li responded that session-level `lastActiveAt` conflates session activity with grant activity, and suggested grant-level `lastUsedAt` as a more accurate signal for the "is this session still being used?" I do not know how Logto will handle this and when, if at all, so the heartbeat remains in Blacktop.

Adds a `last_active_at` timestamp to each session and keeps it up to date automatically:

- New `last_active_at` column in `oidc_session_extensions`, with database migration
- `POST /api/my-account/sessions/heartbeat` endpoint, call this to mark a session alive
- `lastActiveAt` is exposed in the sessions API response and typed in schemas
- Admin Console sessions table now has a "Last Active" column
- i18n keys included

Combined with `isCurrent`, this gives you a full picture of user sessions: which one is current, when each was last active, and the ability to revoke any of them.

#### Client integration (Next.js)

The heartbeat is wired up in three pieces. The server action calls the Logto endpoint. Using a Server Action rather than a fetch to an API route keeps the correct Next.js cookie context:

```ts
// logto-kit/logic/actions/heartbeat.ts
'use server';

import { makeRequest } from './request';

export async function recordHeartbeat(): Promise<void> {
  try {
    await makeRequest('/api/my-account/sessions/heartbeat', { method: 'POST' });
  } catch {
    // Best-effort, silently absorb all errors.
  }
}
```

The client component calls that action every 30 seconds while the tab is visible, and immediately when the user switches back to the tab:

```tsx
// logto-kit/components/handlers/session-heartbeat.tsx
'use client';

import { useEffect, useRef } from 'react';
import { recordHeartbeat } from '../../logic/actions/heartbeat';

const PING_INTERVAL_MS = 30_000;
const DEBOUNCE_MS = 10_000;

export default function SessionHeartbeat() {
  const lastPingRef = useRef<number>(0);

  useEffect(() => {
    const ping = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastPingRef.current < DEBOUNCE_MS) return;
      lastPingRef.current = now;
      recordHeartbeat().catch(() => {});
    };

    ping(); // fire on mount

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') ping();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const intervalId = setInterval(ping, PING_INTERVAL_MS);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(intervalId);
    };
  }, []);

  return null;
}
```

Drop it in the root layout and it runs on every page with no further wiring needed:

```tsx
// app/layout.tsx
import SessionHeartbeat from './logto-kit/components/handlers/session-heartbeat';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionHeartbeat />
        {children}
      </body>
    </html>
  );
}
```

---

## Other Changes from Upstream


- **Hide Logto Branding** unlocked, Toggle in Sign-In Experience > Branding
- **Custom UI / BYUI** unlocked, Upload ZIP files, configure CSP

All "Try Cloud", "Explore Logto Cloud", "Logto Cloud Pricing", and similar SaaS upsell messaging has been stripped from the Admin Console across all 17 locales. The i18n keys are preserved with empty or neutral self-hosted values so nothing breaks at runtime. The `oss-upsell` utility now returns `#` instead of building `cloud.logto.io` URLs, and `openCloudUpsell` is a no-op.

This is a self-hosted fork. You already chose to self-host. You do not need to be sold on the cloud version every time you open the console.

### Dark theme modified 

I did not like the color scheme. So I changed the theme to darker colors, tinted blue instead of violet and purple. Me like.

## License

[MPL-2.0](LICENSE) - same as upstream Logto. (duh)
