// Full-trust host entry: the only place allowed to launch and drive Chrome.

import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { hostContract } from './contract.js';
import { chromeStatus, configureBrowser, fetchPage } from './src/cdp.js';

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async browserStatus({ port, profileDir, chromeBin }) {
      configureBrowser({ port, chromeBin, ...(profileDir ? { profileDir } : {}) });
      const status = await chromeStatus();
      return {
        running: Boolean(status.running),
        port: status.port,
        ...(status.browser ? { browser: String(status.browser) } : {}),
      };
    },

    async fetchListing({ url, port, profileDir, chromeBin }) {
      configureBrowser({ port, chromeBin, ...(profileDir ? { profileDir } : {}) });
      const page = await fetchPage(url);
      return {
        blocked: Boolean(page.blocked),
        url: String(page.url ?? url),
        title: String(page.title ?? ''),
        text: String(page.text ?? ''),
        ...(page.message ? { message: page.message } : {}),
        ...(page.structured ? { structured: page.structured } : {}),
      };
    },
  },
});
