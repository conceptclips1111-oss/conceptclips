# Verification performed

- TypeScript type-check: passed.
- Production frontend build: passed (Vite, about 171 KB gzipped JavaScript + 7.2 KB gzipped CSS).
- Production Worker bundle: passed with esbuild's browser/ESM target. Live Cloudflare deployment is not yet tested.
- 15 API integration tests: passed against isolated SQLite databases.
- PostgreSQL migration integration test: passed against PGlite's PostgreSQL engine, including the profile trigger, server-side pricing, pending/rejected/approved transitions, historical transaction-reference reservations, service-function permissions and denied authenticated table access.
- Browser walkthrough: registration, customer login, product overview, demo order, payment-reference submission, admin login, review/approval, customer library and actual PDF download passed.
- Responsive browser checks: storefront at 390 and 320 CSS pixels, mobile navigation, purchase library, and checkout form. No horizontal page overflow in those checks. These are browser viewport checks, not tests of a physical iOS/Android device or real UPI app.
- Automated Playwright tests are included, but the CLI runner could not start child processes in the agent's Windows sandbox (`spawn EPERM`). The above browser walkthrough used the app's browser automation instead. Run `npm.cmd run test:e2e` outside that sandbox after installing Playwright Chromium.
- Dependency audit after installation: no reported vulnerabilities.

No real payment was sent. No SMS or email was sent. No cloud project or bucket was provisioned. Production Supabase Auth credentials/configuration and a live Cloudflare/R2 deployment still need smoke testing after account setup. See `DEPLOYMENT.md`.
