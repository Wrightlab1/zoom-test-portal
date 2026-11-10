/**
 * Run the mock Zoom server for manual testing:  npm run mock:zoom
 * Point the portal at it with Settings → OAuth base URL / API base URL = http://127.0.0.1:4900
 * and add "http://127.0.0.1:4900" to the allowlist. All credentials below are fake.
 */
import { createMockZoom } from './mock.js';

const port = Number(process.env.MOCK_ZOOM_PORT ?? 4900);
const publicBase = (process.env.MOCK_REDIRECT_BASE ?? 'http://127.0.0.1:4801').replace(/\/+$/, '');

const mock = createMockZoom({
  clients: [
    { clientId: 'mock-s2s-client', clientSecret: 'mock-s2s-secret-not-real', accountId: 'mockaccount1', redirectUris: [] },
    {
      clientId: 'mock-user-client',
      clientSecret: 'mock-user-secret-not-real',
      redirectUris: [`${publicBase}/oauth/callback/mock-user-app`],
    },
  ],
});
const base = await mock.listen(port);
console.log(`Mock Zoom listening on ${base}
  S2S app : client_id=mock-s2s-client  secret=mock-s2s-secret-not-real  account_id=mockaccount1
  User app: client_id=mock-user-client secret=mock-user-secret-not-real (profile slug: mock-user-app)
            registered redirect: ${publicBase}/oauth/callback/mock-user-app
  Control : POST ${base}/__mock/config {"currentUser":"mockuser002"} | POST ${base}/__mock/expire | GET ${base}/__mock/stats`);
