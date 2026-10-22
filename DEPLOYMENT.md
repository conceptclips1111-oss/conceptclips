# Deploy to Cloudflare + Supabase

The local site is a demo until you finish these steps. Never upload `.data`, `.env`, `.dev.vars` or local admin credentials. Use a new production database; the migration is not intended to be rerun over an existing installation.

## 1. Supabase

1. Create a Supabase project, preferably near your Indian audience (Mumbai if available).
2. Open SQL Editor and execute `supabase/migrations/001_store.sql`. It creates tables, indexes, private access policies, the auth-profile trigger, and atomic order/review functions. No sample catalogue or admin is seeded.
3. Enable **Phone** authentication. Disable phone confirmation and disable public signup (`Allow new users to sign up`). Our server-side admin API performs registration with phone pre-confirmation, deliberately without sending SMS; phone ownership remains unverified. Do not configure an SMS provider. Public signup is unnecessary because the Worker validates and rate-limits registration.
4. Copy the project URL, legacy anon key and legacy service_role key into your secret manager. Use the corresponding compatible keys if the dashboard changes; `SUPABASE_ANON_KEY` is for password sign-in, while `SUPABASE_SERVICE_ROLE_KEY` must support the Auth admin APIs and service-role database access.

### Create the initial administrator

After the website is deployed, register your own phone/password through its normal registration screen. It will initially be a customer. In Supabase SQL Editor run this with the correct phone digits (Supabase often stores the phone without `+`):

```sql
update public.profiles
set role = 'admin'
where regexp_replace(phone, '[^0-9]', '', 'g') = '91YOUR_10_DIGIT_NUMBER';
```

Check that exactly your account was promoted. Refresh/re-login to see **Admin**. The app never lets customers assign their own role. Use a strong unique admin password; phone verification/recovery are deliberately absent in this version.

## 2. Cloudflare private R2 storage

Enable R2 billing and create the bucket:

```powershell
npx.cmd wrangler login
npx.cmd wrangler r2 bucket create akhil-notes-private
```

Keep **Public Development URL** and public custom-domain access disabled. The Worker downloads files through its `PDFS` binding after checking approved ownership. No S3 credentials are needed by the application.

R2 free allowances are not a hard spending cap. Set usage/billing alerts. Leave Standard storage selected. Track total PDF size, retained replaced PDFs and operations.

## 3. Worker configuration and secrets

Edit `wrangler.jsonc` with the production `SUPABASE_URL` and `SUPABASE_ANON_KEY`, and bucket name if changed. Only the service role is a secret:

```powershell
npx.cmd wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

Paste it interactively. Do not place it in frontend code, `VITE_*` variables, Git, screenshots or chat. Store settings are persisted in Postgres and edited in the admin portal.

Deploy the combined frontend/API:

```powershell
npm.cmd test
npm.cmd run deploy:check
npm.cmd run deploy
```

Cloudflare assigns a `workers.dev` HTTPS address. Add a custom domain later in the Cloudflare dashboard. Secure, HttpOnly, SameSite=Strict cookies are used in production. The frontend calls same-origin `/api` paths; no permissive CORS configuration is needed.

## 4. Populate and configure

1. Promote your admin account as above.
2. In **Admin > Notes**, create a draft, upload the real PDF, then publish. Add actual page counts, description and syllabus.
3. In **Admin > Settings**, set store name, UPI ID, payee name and support email. Verify the destination in your UPI app before enabling real payment instructions.
4. Replace the draft help content with the owner's final privacy, refund and purchase terms. Do not make claims about tax invoices, instant delivery or refund rights that the store does not support.
5. Confirm the customer registration, payment declaration, admin review and download workflow using a controlled test. When enabled in production, payment details are REAL: do not ask unrelated users to pay for testing.

## 5. Production smoke checks

- `/api/health` reports production; no local-demo banner or default admin hint is visible.
- Login/register use phone/password without generating SMS or email.
- Anonymous callers and customer accounts cannot access admin APIs.
- Customer A cannot view customer B's order or download their purchased PDF.
- Submitting a reference leaves the order pending and does not unlock files.
- A verified admin approval grants only the matching product; rejection preserves a visible reason.
- A duplicate transaction ID is rejected, including case variations.
- Existing orders keep the original price and UPI destination after settings/product edits.
- Direct anon/authenticated Supabase table access is denied; no private R2 public URL exists.
- Logout clears cookies; no service-role key appears in built assets/network responses.
- Review notifications and pending-payment status work from a real Android phone and iPhone as available.

## Operations

Export database backups regularly from Supabase and keep a separate copy of original PDFs. Free-tier backups/support/uptime do not replace your own recovery plan. Monitor Cloudflare requests/CPU, R2 storage/operations, Supabase size/egress and auth activity. Supabase Free may pause after inactivity. Add order pagination before 10,000 historical orders and plan a paid tier if allowances or reliability needs grow.

Unpublishing a product stops new orders; approved buyers can still download it. PDF replacements are shared with all approved buyers for that product. Pending orders continue to use their payment snapshot, including after payments are paused. Admins can continue reviewing those orders.
