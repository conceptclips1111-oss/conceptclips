import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir:'./tests', testMatch:'browser.spec.ts', timeout:45000,
  use:{baseURL:'http://127.0.0.1:8790',trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[
    {name:'mobile',use:{...devices['iPhone 13'],defaultBrowserType:'chromium'}},
    {name:'desktop',use:{...devices['Desktop Chrome']}}
  ],
  webServer:{command:'node --import ./scripts/register-typescript.mjs src/server/local.ts',url:'http://127.0.0.1:8790/api/health',reuseExistingServer:false,env:{API_PORT:'8790',DATA_DIR:`.data/e2e-${Date.now()}`},timeout:30000}
});
