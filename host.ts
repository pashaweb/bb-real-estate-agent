// Full-trust host entry: the only place allowed to launch and drive Chrome.

import { DatabaseSync } from 'node:sqlite';
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

    async readLegacyDb({ path }) {
      // The standalone app stored the scraped fields in `parsed` and a pasted
      // second opinion in gpt_*. Manual corrections in `overrides` win, exactly
      // as they did there.
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const rows = db
          .prepare(
            `SELECT url, parsed, overrides, gpt_opinion, gpt_score, gpt_at
               FROM listings WHERE archived = 0 ORDER BY id`
          )
          .all() as Record<string, any>[];
        return {
          rows: rows.map((r) => {
            const parsed = JSON.parse(String(r.parsed));
            const overrides = JSON.parse(String(r.overrides ?? '{}'));
            const merged = {
              ...parsed,
              ...overrides,
              flags: { ...(parsed.flags ?? {}), ...(overrides.flags ?? {}) },
            };
            return {
              url: String(r.url),
              listing: JSON.stringify(merged),
              verdictText: r.gpt_opinion ? String(r.gpt_opinion) : null,
              verdictScore: r.gpt_score == null ? null : Number(r.gpt_score),
              verdictAt: r.gpt_at ? String(r.gpt_at) : null,
            };
          }),
        };
      } finally {
        db.close();
      }
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
