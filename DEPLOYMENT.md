# Conceptclips1111: architecture, deployment and updates

This guide records the actual first deployment and the issues we resolved. All terminal commands run in **Windows PowerShell on your computer**, not inside Supabase. Run only the SQL examples in **Supabase SQL Editor**.

**Current address:** https://akhil-notes.conceptclips.workers.dev/

The user confirmed the site works after correcting the Cloudflare backend secret. For this installation, initial provisioning is already complete. For future releases use **Step 9**; do not recreate the database, rerun the initial migration or register another subdomain.

## High-level design

```text
                           PRODUCTION WEBSITE
                           ==================

  Customer browser / mobile phone            Admin browser / mobile phone
  - Browse notes and register                 - Upload/publish notes
  - Log in with phone/password                 - Change store and UPI settings
  - Submit UPI transaction reference           - Check bank credit; approve/reject
  - Download approved purchases                - See pending-payment notifications
                   |                                      |
                   +------------------+-------------------+
                                      | HTTPS
                                      v
              +---------------------------------------------------+
              | CLOUDFLARE: akhil-notes Worker + Static Assets      |
              |                                                   |
              | React frontend: pages, forms, QR code, admin UI    |
              | Worker /api/*: validation, sessions, permissions,  |
              | prices, orders, payment review and download checks |
              +---------------------------------------------------+
                         |                  |                |
                server API calls      database API       R2 binding
                         v                  v                v
              +-----------------+ +-------------------+ +----------------+
              | SUPABASE AUTH   | | SUPABASE POSTGRES | | CLOUDFLARE R2  |
              | Accounts,       | | Profiles/roles,   | | Private PDFs   |
              | passwords and   | | products, orders, | | Access checked |
              | login sessions  | | settings, audit,  | | by Worker for  |
              | No SMS for now  | | payment refs      | | buyer/admin    |
              +-----------------+ +-------------------+ +----------------+

  Separate payment path:
  Customer -> UPI app -> Store owner's bank/merchant account
                              |
                    Admin checks actual credit
                              |
                    Approves order through website
                              |
                    Backend permits PDF download

  A submitted transaction ID is a declaration, not payment confirmation.
  No payment gateway or automated bank verification is integrated.
```

### What each component does and why we use it

| Component | Responsibility and reason |
| --- | --- |
| React + TypeScript | Mobile-friendly catalogue, account forms, checkout, purchase library and admin portal. TypeScript helps catch inconsistent data shapes before deployment. |
| Cloudflare Static Assets | Serves built frontend HTML, JavaScript and CSS. The browser downloads these files. |
| Cloudflare Worker + Hono | Runs the backend API. Validates inputs, checks identity/roles, calculates prices, controls orders and authorises downloads. Secret keys stay here, not in browser code. |
| Supabase Auth | Manages production accounts, password handling and sessions without us maintaining that entire authentication system. We currently use phone/password without OTP. |
| Supabase Postgres | Stores structured application records: profiles, roles, products, orders, UPI settings, transaction-reference history and audit records. |
| Cloudflare R2 | Stores the actual PDF bytes privately. Large PDFs belong in object storage rather than database rows. The Worker uses a binding, so no S3 access key is needed by the app. |
| UPI QR / link | Generated from admin-configured UPI details and order amount. Opens an external UPI app; it cannot verify that money arrived. |
| Admin notifications | Pending orders from our database, checked every 30 seconds while the portal is open. No email/SMS service or background push is required. |
| Wrangler | Cloudflare's developer CLI for login, secrets, bucket provisioning and deployments. It runs on the developer's computer, not on each customer request. |
| Git / GitHub | Source version history and collaboration. With the current manual deployment setup, GitHub is not the running server and pushing code does not deploy it. |
| Local SQLite / Node | Account-free local testing. Local accounts and PDFs stay on your computer; production uses the cloud adapters instead. |

After login the browser sends an HttpOnly session cookie to the backend. Browser code does not get the Supabase server secret. Backend authorisation, not hidden buttons, protects admin operations and purchased downloads.

### Local and production are separate

| Item | Local testing | Production |
| --- | --- | --- |
| Frontend | Vite on 5173, or built files on 8788 | Cloudflare Static Assets |
| API | Node on 8788 | Worker `akhil-notes` |
| Accounts | Local password hashes/session records | Supabase Auth |
| Application database | `.data/notes.sqlite` | Supabase Postgres |
| PDFs | `.data/pdfs/` | Private R2 bucket `akhil-notes-private` |
| Sample data/admin | Automatically seeded for local testing | Not seeded |
| Payments disabled | Allows clearly marked demo orders | Pauses new purchases |

One repository and one Worker deployment publish frontend/backend together. Database migrations and bucket provisioning are separate. Deploying does not migrate local accounts, demo orders, UPI settings or PDFs.

## Costs and card details

We target free usage allowances for hosting, database, authentication and PDF storage. This is not a promise of permanent zero cost or a hard spending cap.

**Cloudflare R2 asked for billing/card details during setup even though we intended to stay in the free allowance.** R2 is a usage-billed storage subscription with included free usage. Providing a billing method does not mean buying Workers Pro, but usage beyond included allowances can generate charges. Review the checkout and billing terms before enabling it; configure usage/billing alerts and monitor retained PDF versions.

No SMS provider, email sender or payment-gateway account is needed for this version. A custom domain, if purchased, has a registration/renewal cost; the current workers.dev address avoids that purchase. Supabase/Cloudflare paid upgrades are separate choices when usage or reliability requirements justify them.

Official R2 setup and prices:
- https://developers.cloudflare.com/r2/get-started/
- https://developers.cloudflare.com/r2/pricing/

## Step 0 - Prepare the local project

Install Node.js 24 LTS with npm. Open Windows PowerShell:

```powershell
cd "C:\Users\agarw\Desktop\Rahul\AkhilWebsite"
npm.cmd install
```

`npm.cmd` / `npx.cmd` work without changing PowerShell's script-execution policy. Use the project folder for every Wrangler command. Running from `C:\Users\agarw` caused **Required Worker name missing** because Wrangler could not find `wrangler.jsonc`.

Save credentials in a password manager or another secure place. A separate paid secrets service is not required.

## Step 1 - Create the Supabase project

1. Open https://supabase.com/dashboard and create/sign into your account.
2. Create a project, select a region near your audience and the Free plan if appropriate.
3. Save its database password securely. This password is not the API key used by our backend.
4. Wait until the project is ready.
5. Find the **Project Reference** in Project Settings or the URL:
   `https://supabase.com/dashboard/project/YOUR_PROJECT_REF/...`

Enter only the project reference when a script asks for it, not the whole URL. This is a new production environment, separate from local SQLite.

## Step 2 - Run the database migration once

1. Open the new project's **SQL Editor -> New query**.
2. Open `supabase/migrations/001_store.sql` in this repository.
3. Copy the **entire file**, from `begin;` through `commit;`, into SQL Editor and run it.
4. Confirm success. If an RLS warning appears, the complete migration enables Row Level Security and revokes anonymous/customer table access in the same transaction. Choose **Run and enable RLS** if offered. Do not run only the table-creation section.

The migration creates seven application tables:

| Table | Purpose |
| --- | --- |
| `profiles` | Name, phone, email and customer/admin role |
| `products` | Descriptions, integer-paise prices and private PDF references |
| `orders` | Purchase amount/payment-destination snapshots and review status |
| `payment_references` | Submitted reference history to prevent cross-order reuse |
| `store_settings` | Store name, UPI details and payment switch; starts disabled |
| `audit_log` | Payment submissions, reviews and settings changes |
| `rate_limits` | Backend request limits |

It also creates the `order_details` view, profile trigger and atomic order/payment functions. It creates **no admin or customer account**. All seven tables have RLS enabled; direct public/customer table access is denied. The Worker accesses data through its server-only key after checking application permissions.

Optional read-only confirmation:

```sql
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in (
    'profiles', 'products', 'orders', 'payment_references',
    'store_settings', 'audit_log', 'rate_limits'
  )
order by tablename;

select id, data->>'store_name' as store_name
from public.store_settings
where id = 1;
```

Expect seven RLS-enabled tables and one settings row. Do not disable RLS to resolve connectivity problems.

**Run this initial migration only once on a new project.** Future schema changes need new migrations. An `already exists` error is not a reason to delete production tables or rerun selected fragments.

## Step 3 - Configure phone/password authentication without SMS

### Why public signup is disabled

The Worker calls Supabase's protected Auth admin API to create a customer, then signs them in using phone/password. A database trigger creates their customer profile. Disabling direct public signup means registration goes through our backend validation and rate limits; it does not disable registration through our website.

The backend currently uses `phone_confirm: true` to skip SMS. This is **auto-confirmation, not proof of phone ownership**. Email is contact information in `profiles`, not an Auth email-login identity. Genuine phone/email verification later requires changing this flow and handling existing users explicitly.

### Target configuration

Under **Authentication -> Sign In / Providers -> Phone**, where the dashboard supports this configuration:

| Setting | Value |
| --- | --- |
| Enable Phone provider | On |
| Confirm phone / Enable phone confirmations | Off |
| Allow new users to sign up | Off |

No Google provider, SMS delivery, SMTP or phone MFA is needed now.

### If the dashboard requires Twilio credentials

This happened during our deployment. Cancel the unsaved form. Do not enter fake Twilio credentials or buy SMS service. We successfully applied the settings through the official **Supabase Management API**:

1. Generate a temporary **personal access token** at https://supabase.com/dashboard/account/tokens. It must be allowed to update this project's Auth config. The endpoint lists `auth_config_write` and `project_admin_write` for fine-grained tokens.
2. Copy the actual token value when shown, not the token's name.
3. Run the following script in **Windows PowerShell**, not Supabase.
4. Enter the project reference.
5. At the second prompt, switch to Supabase, copy the token, return to PowerShell and press Enter. The script reads the clipboard; do not paste the token into the terminal.

```powershell
$projectRef = (Read-Host "Supabase project reference").Trim()

Read-Host "Now copy your Supabase personal access token, then press Enter here" |
    Out-Null

try {
    $tokenText = (Get-Clipboard -Raw) -replace '\s', ''

    if ($projectRef -notmatch '^[a-z0-9]{20}$') {
        throw "Enter only the 20-character project reference."
    }
    if ($tokenText -notmatch '^sbp_[A-Za-z0-9_-]+$') {
        throw "The clipboard does not contain a Supabase personal access token."
    }

    $headers = @{ Authorization = "Bearer $tokenText" }
    $body = @{
        external_phone_enabled = $true
        sms_autoconfirm = $true
        disable_signup = $true
    } | ConvertTo-Json

    $result = Invoke-RestMethod `
        -Method Patch `
        -Uri "https://api.supabase.com/v1/projects/$projectRef/config/auth" `
        -Headers $headers `
        -ContentType "application/json" `
        -Body $body `
        -ErrorAction Stop

    $result | Select-Object `
        external_phone_enabled, sms_autoconfirm, disable_signup
}
finally {
    Remove-Variable tokenText, headers, result -ErrorAction SilentlyContinue
}
```

Expected result: **True / True / True**. If the API returns an error, do not assume the settings were applied.

The earlier hidden-input `Read-Host -AsSecureString` method received invalid characters in the user's terminal, causing `Specified value has invalid control characters`. Reading a freshly copied token from the clipboard resolved the input issue.

After success, revoke the temporary personal access token and copy harmless text to clear the clipboard. Revoking it does not undo the project settings. Do not put that token in Git, chat, screenshots or the Worker secret.

### Collect the connection values too

Find the project URL in **Connect** / **Settings -> Data API**, and keys in **Settings -> API Keys**:

| Value | Format | App variable | Destination |
| --- | --- | --- | --- |
| Project root URL | `https://YOUR_PROJECT_REF.supabase.co` | `SUPABASE_URL` | `wrangler.jsonc` |
| Publishable key or legacy anon key | `sb_publishable_...` | `SUPABASE_ANON_KEY` | `wrangler.jsonc` |
| Secret key or legacy service_role key | `sb_secret_...` | `SUPABASE_SERVICE_ROLE_KEY` | Cloudflare encrypted Worker secret |
| Personal access token | `sbp_...` | Not used by app | Temporary Management API setup only |

Prefer the newer publishable/secret keys. App variable names retain legacy terminology but accept the corresponding newer types.

**Use the root project URL, without `/rest/v1/`, `/auth/v1/` or dashboard paths.** The SDK adds service paths itself. We had to correct an initially supplied `/rest/v1/` endpoint.

The URL and publishable key can be committed. Never commit a secret/service_role key, bundle it into frontend code or store it in a `VITE_*` variable. Rotate leaked secrets; making an exposed repo private does not undo exposure.

## Step 4 - Configure Cloudflare and private R2 storage

1. Open https://dash.cloudflare.com and create/sign into your account.
2. Enable R2. **Expect a billing/card requirement even when targeting free usage**; review billing and set alerts.
3. Create a **Standard** bucket named `akhil-notes-private` through the dashboard or, after login, the CLI:

```powershell
cd "C:\Users\agarw\Desktop\Rahul\AkhilWebsite"
npx.cmd wrangler login
npx.cmd wrangler r2 bucket create akhil-notes-private
```

If it already exists, do not recreate it. Keep **Public Development URL** and public custom-domain access disabled. The Worker uses its `PDFS` binding, and enforces download permissions.

### Wrangler login permissions

`wrangler login` opens Cloudflare's OAuth consent page. Login authorises the CLI; it does not deploy the website.

The page may request permissions for unrelated products. Use **Edit Permissions** to limit optional access. Keep required identity/background access, account-read access, Workers deployment/edit access and R2 permissions needed by your commands. Add DNS/custom-domain permissions later when needed. Billing modification is unnecessary simply to deploy code. Expand categories such as "Account & Billing" to read the individual permissions. If a command is denied, reauthorize with the specific missing scope.

## Step 5 - Configure the Worker and server secret

### Edit and commit public configuration

In `wrangler.jsonc`, update only the relevant values, keeping the rest of the configuration:

```jsonc
"vars": {
  "SUPABASE_URL": "https://YOUR_PROJECT_REF.supabase.co",
  "SUPABASE_ANON_KEY": "sb_publishable_YOUR_ACTUAL_PUBLISHABLE_KEY"
}
```

Use values from the same project where you ran the migration. Preserve Worker name `akhil-notes`, entry point `src/server/worker.ts`, asset directory `./dist`, and binding `PDFS` pointing to `akhil-notes-private`. If resource names differ, update them consistently. Do not replace the whole file with only the `vars` example.

### Store the backend secret in Cloudflare

```powershell
cd "C:\Users\agarw\Desktop\Rahul\AkhilWebsite"
npx.cmd wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

At **Enter a secret value**, paste the full `sb_secret_...` key or the legacy key explicitly labelled **service_role**. Do not paste the key's name, publishable key, database password, `sbp_...` token, quotes or `Bearer`.

If asked to create Worker `akhil-notes`, confirm. A successful secret upload creates/updates the Worker secret; it does not publish the complete app.

**If terminal input is unreliable, use the dashboard:**

1. Open **Cloudflare -> Workers & Pages -> akhil-notes -> Settings -> Variables and Secrets**.
2. Add/edit `SUPABASE_SERVICE_ROLE_KEY`.
3. Keep type **Secret**, paste the freshly copied full key, and Save/Deploy.
4. Create the Worker with the CLI first if it does not exist yet.

Our initial live database failure was ultimately resolved by replacing an incorrectly formatted secret in this dashboard. The backend's `DB_CONFIG` validation made the problem visible. A masked value does not establish that a saved secret is correct.

Do not add this to Supabase Edge Function Secrets: our backend runs on Cloudflare. Keep a secure recovery copy in a password manager if necessary.

## Step 6 - Build and deploy the site

### First deployment

```powershell
cd "C:\Users\agarw\Desktop\Rahul\AkhilWebsite"
npm.cmd test
npm.cmd run deploy:check
```

- `test` checks API permissions, payment flow, PostgreSQL migration and server-key/header handling.
- `deploy:check` type-checks/builds frontend assets and bundles a dry-run Worker deployment. It does not publish or establish that live database credentials work.

Stop if either fails. If both pass:

```powershell
npm.cmd run deploy
```

This builds/uploads frontend and backend code, configuration and bindings. Existing Worker secrets remain separate from the repository.

### Register the workers.dev subdomain once

Wrangler initially uploaded code, then requested a workers.dev subdomain:

1. Answer **y** to register one.
2. Enter a name such as `conceptclips`, without `https://` or `.workers.dev`.
3. Confirm the proposed name with **y**. Choose an available alternative if taken.
4. Wait for **Deployed ... triggers** and the final URL.

For this installation: **https://akhil-notes.conceptclips.workers.dev/**

The Worker is `akhil-notes`; the account subdomain is `conceptclips`. Use the exact printed URL or check **Settings -> Domains & Routes**. A purchased custom domain is optional.

### Understand normal deployment output

- React Router's `"use client" was ignored` warnings occurred in a successful build; check the final result.
- `No updated asset files to upload` means frontend assets are unchanged; backend/configuration can still deploy.
- Wrangler/npm update notices do not mean deployment failed.
- The bindings table does not reveal or validate the server-secret value.
- `/api/health` returning `{"ok":true,"mode":"production"}` confirms the API/configuration initialises. It does not test database queries or PDF uploads.

## Step 7 - Create the production admin

1. Register on the **deployed website**, not localhost, with your own phone/email and a strong unique password.
2. New users are customers; the migration creates no admin.
3. Replace the example number below with your registered number, including country code, in Supabase SQL Editor:

```sql
update public.profiles
set role = 'admin'
where regexp_replace(phone, '[^0-9]', '', 'g') = '919876543210'
returning id, name, phone, role;
```

4. Confirm exactly your account is returned as `admin`. Zero rows means the number does not match or the account was registered locally instead.
5. Refresh or log out/back in to see Admin.

The demo account `9000000000` / `LocalAdmin!2026` is not seeded into Supabase. Do not reuse that password. Store the real password securely; recovery is not implemented.

## Step 8 - Populate, configure and verify the store

1. **Admin -> Notes -> Add notes:** enter the actual subject/title, description, overview, price and page count. Choose the PDF directly in the same form (maximum 30 MB).
2. Check **Published and available to buy**, then click **Save & publish notes**. Saving uploads the PDF before publishing; R2 stays private. You can also save a draft without a PDF. If upload fails, retry in the open editor; the saved draft is reused.
3. **Admin -> Settings:** set store name, UPI ID, payee name and support email. The QR/link is generated automatically.
4. Verify the UPI destination in your payment app. Finalise the owner's privacy, refund and purchase/access terms. The current Help page contains draft information.
5. Keep real payments disabled until ready. In production this pauses new purchases, rather than creating local-style demo orders.
6. For a controlled live test, enable real payment instructions, tick the confirmation and save. Actual payments now go to the configured account.
7. Use a separate customer account: order, pay, submit reference/payer/time. Submission must leave the order pending.
8. Admin checks the **actual bank/merchant credit**, then approves in Notifications. A reference alone is not proof.
9. Confirm PDF access after approval and blocked access from another account. Check phones and desktop, and rejection/correction without paying twice.

Orders retain their original price and UPI destination when settings change. Existing local demo orders stay demo; use another not-yet-ordered product/account for local real-instruction testing. Replacing a PDF makes the latest version available to approved buyers. Unpublishing stops new sales while preserving approved downloads.

## Step 9 - Commit changes and make them appear on the website

### Current setup: manual deployment from your computer

```text
  Edit local files
        |
        v
  Test locally -> automated tests -> deployment dry run
        |
        v
  Review Git diff -> commit -> push to GitHub (source backup/history)
        |
        v
  npm.cmd run deploy
        |
        v
  Wrangler uploads LOCAL frontend/backend to Cloudflare
        |
        v
  Open live URL and smoke-test the changed behaviour
```

**Committing/pushing alone does not update this website.** No GitHub automatic deployment was configured by these steps. `npm.cmd run deploy` uses current local files, even uncommitted ones; it does not pull GitHub. This explains why our uncommitted troubleshooting fixes could be deployed.

Recommended workflow:

```powershell
cd "C:\Users\agarw\Desktop\Rahul\AkhilWebsite"

git status
git diff
npm.cmd test
npm.cmd run deploy:check
```

Test the changes locally too using `npm.cmd run dev`, or `npm.cmd run build` followed by `npm.cmd start`. Stop the previous local API before starting another instance on the same port.

Stage only reviewed source/config/documentation, commit and push. Example paths (adjust to the files you actually changed):

```powershell
git add src tests DEPLOYMENT.md README.md
git commit -m "Describe the change"
git push
npm.cmd run deploy
```

If dependencies changed, also stage `package.json` and `package-lock.json`. If public Worker configuration changed, stage `wrangler.jsonc` after checking that it contains no server secrets. Review `git diff --cached` before committing. Never stage credentials, local customer data or private PDFs.

After successful deployment, open the exact live URL and test the changed behaviour. A code deployment normally preserves production database rows, R2 objects and Worker secrets.

### Which changes need which action?

| Change | Required action |
| --- | --- |
| React pages/styles or backend API code | Test, commit/push, then `npm.cmd run deploy` |
| Dependencies | Update lockfile, test, commit/push and deploy |
| Public `wrangler.jsonc` values/bindings | Review, commit/push and deploy; provision any newly referenced resources |
| Worker secret | Update through dashboard or `wrangler secret put`; never commit its value |
| Product price/overview or UPI details | Save in the admin portal; no source commit/deployment |
| Product PDF | Upload in Admin; no source commit/deployment |
| Database schema | Add/apply a new migration deliberately, then deploy compatible backend changes |
| Local SQLite test records | No automatic transfer to production |

Do not rerun the initial migration or recreate resources for ordinary code updates.

If you later want push-to-deploy, explicitly configure Cloudflare Builds/GitHub integration or a GitHub Actions workflow with appropriate scoped credentials. Once configured, that workflow deploys the pushed commit. Until then, use manual deployment.

## Troubleshooting from the first deployment

### ERR_NAME_NOT_RESOLVED / server IP not found

This happens before the app or Supabase is contacted. Confirm deployment finished and workers.dev is enabled in **Settings -> Domains & Routes**. Compare DNS:

```powershell
Resolve-DnsName akhil-notes.conceptclips.workers.dev
Resolve-DnsName akhil-notes.conceptclips.workers.dev -Server 1.1.1.1
Resolve-DnsName akhil-notes.conceptclips.workers.dev -Server 8.8.8.8
```

Our system resolver reported no domain while public Cloudflare/Google DNS returned addresses. Clear local cache:

```powershell
ipconfig /flushdns
```

Reopen the browser. Try the phone with Wi-Fi off. If mobile data works but the normal network does not, investigate its resolver/cache. Database changes and repeated deployments do not fix DNS. Browser Secure DNS with Cloudflare/Google may help where available. Do not disable TLS validation or hardcode service IPs in application settings.

### DB_CONFIG: backend secret has the wrong format

This identified our server-secret problem. Replace `SUPABASE_SERVICE_ROLE_KEY` with the full secret/service_role key from the correct project using Step 5. Use the dashboard if terminal input is unreliable. Save/Deploy and reload.

Format validation recognises `sb_secret_...` or a legacy JWT carrying `service_role`; it does not prove that a correctly formatted key is active or belongs to the correct project. Supabase verifies that.

### Generic database-unavailable message

Check the root project URL, matching project keys, complete/active server secret, running Supabase project and completed migration, including the settings seed row and grants. Public-key access to `products` being denied is expected; the Worker uses its privileged key after authorisation.

Do not disable RLS, expose the bucket, rerun the initial migration over live tables or repeatedly rotate keys without evidence.

### Live logs

```powershell
cd "C:\Users\agarw\Desktop\Rahul\AkhilWebsite"
npx.cmd wrangler tail akhil-notes --format pretty
```

Leave it running and reproduce the issue elsewhere; Ctrl+C stops it. A request marked **OK** in tail output does not necessarily mean HTTP 200 or successful database access; the Worker can handle an error normally.

Temporary `DB_QUERY`, `DB_AUTH`, `DB_PERMISSIONS`, `DB_SCHEMA`, `DB_SETTINGS`, `DB_CONNECTION`, `supabase_request_failed` and `supabase_http_failed` diagnostics were removed after success. Current code retains `DB_CONFIG` validation and server-side API-key handling. Redeploy cleaned-up code to remove temporary messages from production; historical logs reflect the version that generated them.

### Confirmed findings versus inference

- Root URL needed correction; the original value included `/rest/v1/`.
- Management API phone configuration succeeded without Twilio.
- Public/system DNS answers differed for the new hostname.
- Key validation exposed a malformed/wrong-type server-secret value.
- The user replaced the secret in Cloudflare and confirmed the site worked.
- We also corrected newer API-key header handling while preserving user JWTs/legacy Bearer tokens. This follows Supabase guidance and is tested, but was **not independently proven as the cause** of the outage.

## Source control and operations

### Store branding and website address

Change **Admin -> Settings -> Store name** to `Conceptclips1111` and save on the live website. Header/footer use this database value; the browser tab title follows it after deploying the current code. Local SQLite settings are separate, so update the local admin settings too if testing an existing local database. Code defaults apply to new local databases; the original production migration is historical and must not be rerun for branding.

The initial HTML title and frontend fallback now use `Conceptclips1111`. Build/deploy these code changes normally. Internal package names, backend User-Agent, the existing Worker and private bucket can retain their original names without showing them as the store name.

The current URL remains `https://akhil-notes.conceptclips.workers.dev/`. A workers.dev URL is `<worker-name>.<account-subdomain>.workers.dev`; a Worker named `conceptclips1111` under the current account subdomain would use `https://conceptclips1111.conceptclips.workers.dev/`. This is a proposed address, not an already deployed endpoint.

To move URLs, first plan the Worker rename/new deployment and update the `name` in `wrangler.jsonc` consistently. Changing only that field and deploying can create a separate Worker: configure its server secret and confirm the existing R2 binding/Supabase values before sending users to it. Existing database records/PDFs can be reused. Users may need to log in again because cookies belong to the old hostname. Existing shared links need updating or a deliberate redirect. Do not rename/delete the PDF bucket or recreate Supabase for a branding change.

Alternatively, attach a domain you own in the Worker's **Settings -> Domains & Routes -> Add -> Custom Domain**. This keeps the internal Worker name separate from the customer-facing URL; domain availability and registration/renewal cost are separate. See the official workers.dev and Custom Domains references below.

Commit source, tests, migrations, package files/lockfile, public configuration, example environment files and documentation. Keep `.env`, `.dev.vars`, `.data/`, real PDFs, credentials, caches, `node_modules/`, build output, Wrangler state and test reports out of Git. A private repository is not a secret manager.

Back up Postgres and original PDFs. Monitor Worker CPU/requests, R2 storage/operations and Supabase size/egress/auth usage. Free allowances/inactivity policies can change. Retained replaced PDFs can increase storage; remove unused objects deliberately after checking references. Add pagination before the current 10,000-order history limit matters.

This version has no automatic refunds, access-revocation UI, tax invoices, cart or password recovery. Notifications update while the portal is open. Pending orders can be reviewed after new purchases are paused.

## Official references

- Phone/password auth: https://supabase.com/docs/guides/auth/passwords
- Auth configuration API: https://supabase.com/docs/reference/api/v1-update-auth-service-config
- Supabase API keys: https://supabase.com/docs/guides/getting-started/api-keys
- Wrangler: https://developers.cloudflare.com/workers/wrangler/
- workers.dev: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Custom Domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- R2 setup/pricing: https://developers.cloudflare.com/r2/get-started/ and https://developers.cloudflare.com/r2/pricing/
