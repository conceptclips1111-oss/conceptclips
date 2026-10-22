# Verification performed

- TypeScript type-check: passed.
- Production frontend build: passed (Vite, about 171 KB gzipped JavaScript + 7.2 KB gzipped CSS).
- Production Worker bundle: passed with esbuild's browser/ESM target. The owner confirmed the live website works after correcting its Cloudflare Supabase secret. The cleanup in this revision has been checked locally and still needs deployment.
- 15 API integration tests: passed against isolated SQLite databases.
- PostgreSQL migration integration test: passed against PGlite's PostgreSQL engine, including the profile trigger, server-side pricing, pending/rejected/approved transitions, historical transaction-reference reservations, service-function permissions and denied authenticated table access.
- Three Supabase transport tests: passed for newer API-key headers, preservation of user JWTs/legacy Bearer keys, installed SDK database/Auth-admin requests, and safe rejection of malformed/wrong-type backend secrets. Total automated tests: 19 passed.
- Inline PDF creation: type-check, production frontend build and the 19 automated tests pass after this change. A new mobile/desktop Playwright scenario covers selecting a PDF during creation, failed-upload recovery without duplicate notes, and publishing to the catalogue. Its execution is pending: the CLI cannot launch child processes in this Windows sandbox (`spawn EPERM`).
- Browser walkthrough: registration, customer login, product overview, demo order, payment-reference submission, admin login, review/approval, customer library and actual PDF download passed.
- Responsive browser checks: storefront at 390 and 320 CSS pixels, mobile navigation, purchase library, and checkout form. No horizontal page overflow in those checks. These are browser viewport checks, not tests of a physical iOS/Android device or real UPI app.
- Automated Playwright tests are included, but the CLI runner could not start child processes in the agent's Windows sandbox (`spawn EPERM`). The above browser walkthrough used the app's browser automation instead. Run `npm.cmd run test:e2e` outside that sandbox after installing Playwright Chromium.
- Dependency audit after installation: no reported vulnerabilities.

No real payment, SMS or email was sent by these tests. Cloud provisioning and the first deployment were completed by the owner. A complete production purchase/approval/private-PDF walkthrough remains a separate check; local test results do not establish that the live flow passes. See `DEPLOYMENT.md` for setup, deployment history, and the production smoke-test checklist.
