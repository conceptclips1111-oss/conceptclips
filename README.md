# Akhil Notes

Mobile-first PDF notes shop: customer accounts, catalogue, manual UPI checkout, transaction-reference submissions, admin review, and protected PDF downloads. One repository, one Cloudflare deployment. No OTP, screenshot upload, email delivery, or password recovery.

## Run locally

Requires **Node.js 24 LTS** and npm. You already have a compatible Node version.

```powershell
cd C:\Users\agarw\Desktop\Rahul\AkhilWebsite
npm.cmd install
npm.cmd run dev
```

Open **http://127.0.0.1:5173**. Vite serves the frontend and proxies `/api` to the local API on port 8788. The API binds to loopback only. No cloud accounts, Docker, SMS service, or payment account are needed.

To serve the built website and API on a single port instead:

```powershell
npm.cmd run build
npm.cmd start
```

Open **http://127.0.0.1:8788**. Restart `npm start` after editing backend files; rebuild after editing frontend files.

### Local admin

- Phone: **9000000000**
- Password: **LocalAdmin!2026**
- Admin URL: `/admin`

These credentials exist only in the local SQLite database. They are never created in the deployed database. To override them, copy `.env.example` to `.env` and set `LOCAL_ADMIN_PHONE` / `LOCAL_ADMIN_PASSWORD` **before the first local startup**. Changing those variables later does not change an existing account's password.

The local site starts with four clearly labelled sample products, one-page demo PDFs, and real payments disabled. The sample page counts are illustrative catalogue metadata, not the actual size of the demo PDFs.

### Test the whole purchase flow

1. Register a customer account using fictional test details. Save the password.
2. Choose a product and click **Get these notes**.
3. Leave real payments disabled. Do not send money.
4. Enter a fictional 8–40 character reference, e.g. `DEMO123456789`, payer name and current payment time. Submit.
5. Log out and log in as the local admin.
6. Open **Admin > Notifications**. Review the demo order, tick the verification checkbox, and approve it.
7. Log back in as the customer. **My purchases** now offers a PDF download.
8. Try rejection and correction on another product. Reusing a transaction reference against another order is rejected.

Admin **Notes -> Add notes** lets you enter details and select a private PDF (up to 30 MB) in the same form. Select **Published and available to buy** and **Save & publish notes** to upload and publish together, or **Save draft** to finish later. Failed uploads leave the saved draft in the editor for retry. You can also replace PDFs and edit or unpublish existing notes. Replacing a PDF makes the latest version available to all customers with an approved purchase. Old object versions are retained; remove unused versions deliberately after checking references to manage storage.

Admin **Settings** controls the store name, UPI ID, payee name, optional support email and payment enable switch. The site generates the QR from those details. Existing orders retain their original amount and payment destination. In local mode, disabled payments allow demo orders; in production, disabled payments pause new purchases entirely.

### Local data

`.data/notes.sqlite` stores local accounts, hashed passwords, hashed session tokens, orders, settings, rate limits and audit history. PDFs live under `.data/pdfs/`. Both are ignored by Git. Local customer data is **not** migrated to production.

The local API uses SQLite and scrypt. Production uses Supabase Auth/Postgres and R2 through separate adapters behind the same API. Local tests do not prove remote credentials, Supabase settings, or cloud network behaviour; run the production smoke checks in `DEPLOYMENT.md` after provisioning.

### Verification

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
```

API tests cover customer/admin permissions, ownership, protected downloads, server-priced orders, duplicate references, review races, rejection/resubmission, settings snapshots, request-origin checks and PDF validation. E2E tests require Playwright Chromium (`npx.cmd playwright install chromium`) and a frontend build (`npm.cmd run build`). They start a separate API/static server on port 8790 with a disposable test database, and cover mobile and desktop flows.

## Deployment

See `DEPLOYMENT.md`. Requires a Cloudflare account with R2 enabled and a Supabase project. Deployment does not use the local database, default admin credentials or sample catalogue. Keep production payment instructions disabled until real PDFs, policies and UPI details are ready. `TESTING.md` records checks actually performed and their limits.

## Deliberate first-version limits

- Phone/email are unverified. A phone is a login identifier, not proof of ownership.
- No password reset or account recovery UI. Users must keep their password.
- Payment references are declarations; admin approval requires checking the actual bank credit.
- Admin notifications poll every 30 seconds while the portal is open; no background push/email.
- Each order contains one product. No cart, coupons, tax invoice engine or automatic refunds.
- Admin order queries currently return the latest 10,000 orders in production. Add pagination before that history limit is reached.
- Manual approval is final in this UI. Refund/revoke-access workflows are not included.
- The help page contains draft purchase information. The owner must provide final privacy, refund and purchase terms before launch.
- Rate limits protect registration/login/downloads; use Cloudflare WAF/Turnstile if abuse requires stronger controls.
- No analytics/cookie advertising services are installed. Google Fonts is an external font request; self-host fonts if required by your privacy policy.

## Source map

`src/web/`: React customer/admin UI and responsive styles. `src/server/app.ts`: shared API and authorisation. `local-services.ts`: local database/auth/files. `cloud-services.ts`: Supabase/R2 adapter. `worker.ts`: production entry and security headers. `supabase/migrations/001_store.sql`: schema, RLS and atomic payment operations. All prices are integer paise; timestamps are stored in UTC and displayed in the viewer's local timezone.
