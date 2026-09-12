// bb-plugin-real-estate-agent — scores Idealista listings and asks a model you
// choose to second-guess the score.
//
// Two halves: a deterministic scorer (district benchmarks, yield, risk flags)
// that always runs, and an evaluation by one of BB's configured provider
// models, run in a hidden thread so any provider BB can talk to can serve it.
// Reading the page needs a real browser, which lives in host.ts.

import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { hostContract } from './contract.js';
import { parseListing } from './src/parse.js';
import { buildPrompt, extractScore } from './src/prompt.js';
import { config as scoringConfig, scoreListing } from './src/score.js';
import type { Listing, ModelOption, ModelVerdict, Score } from './src/types.js';

export interface Row {
  id: number;
  url: string;
  listing: Listing;
  score: Score;
  verdict: ModelVerdict | null;
  addedAt: string;
  updatedAt: string;
}

/**
 * Rows carry the scorer's own output verbatim. Validating the nested Listing
 * and Score shapes again here would duplicate src/types.ts without adding
 * safety: this is our data going out, not freeform input coming in.
 */
const rowSchema = z.object({
  id: z.number(),
  url: z.string(),
  listing: z.any(),
  score: z.any(),
  verdict: z.any().nullable(),
  addedAt: z.string(),
  updatedAt: z.string(),
});

const modelSchema = z.object({
  id: z.string(),
  ref: z.string(),
  displayName: z.string(),
  description: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  isDefault: z.boolean(),
});

export const rpcContract = defineRpcContract({
  listings_list: {
    input: z.null(),
    output: z.object({ listings: z.array(rowSchema) }),
  },
  listings_add: {
    input: z
      .object({
        url: z.string().min(1).max(2000),
        askModel: z.boolean().optional(),
        model: z.string().max(200).optional(),
      })
      .strict(),
    output: z.object({ listing: rowSchema }),
  },
  listings_evaluate: {
    input: z
      .object({ id: z.number().int().positive(), model: z.string().max(200).optional() })
      .strict(),
    output: z.object({ listing: rowSchema }),
  },
  listings_remove: {
    input: z.object({ id: z.number().int().positive() }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  models_list: {
    input: z.null(),
    output: z.object({ models: z.array(modelSchema), selected: z.string() }),
  },
  model_select: {
    input: z.object({ ref: z.string().min(1).max(200) }).strict(),
    output: z.object({ selected: z.string() }),
  },
});

/** Frontend views refetch when this fires. */
const LISTINGS_CHANGED = 'listings-changed';

const eur = (n: number | null | undefined) =>
  n == null ? '—' : `€${Math.round(n).toLocaleString('es-ES')}`;
const nowIso = () => new Date().toISOString();

/** Idealista only. Anything else is a typo we should refuse loudly. */
function normaliseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`Not a URL: ${raw}`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are supported.');
  if (!/(^|\.)idealista\.com$/i.test(u.hostname)) {
    throw new Error(`Expected an idealista.com listing, got ${u.hostname}.`);
  }
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) {
    if (/^utm_|^xtmc|^xtnp/.test(k)) u.searchParams.delete(k);
  }
  return u.toString();
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    evaluationModel: {
      type: 'string',
      label: 'Evaluation model',
      default: '',
      experimental_schema: z
        .string()
        .max(200, 'Model id must be at most 200 characters'),
    },
    evaluationProject: {
      type: 'project',
      label: 'Project for evaluation threads',
    },
    autoEvaluate: {
      type: 'boolean',
      label: 'Ask the model automatically when a listing is added',
      default: true,
    },
    chromePort: {
      type: 'number',
      label: 'Chrome DevTools port',
      default: 9222,
      experimental_schema: z.number().int().min(1).max(65535),
    },
    chromeBin: {
      type: 'string',
      label: 'Chrome binary (blank = autodetect)',
      default: '',
    },
    chromeProfileDir: {
      type: 'string',
      label: 'Chrome profile directory (blank = ~/.bb-real-estate-agent)',
      default: '',
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS listings (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       url        TEXT NOT NULL UNIQUE,
       listing    TEXT NOT NULL,
       score      TEXT NOT NULL,
       verdict    TEXT,
       added_at   TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  ]);

  const host = bb.hosts.experimental_client({ contract: hostContract });

  // ---------------------------------------------------------------- storage
  const hydrate = (r: any): Row => ({
    id: r.id,
    url: r.url,
    listing: JSON.parse(r.listing),
    score: JSON.parse(r.score),
    verdict: r.verdict ? JSON.parse(r.verdict) : null,
    addedAt: r.added_at,
    updatedAt: r.updated_at,
  });

  const allRows = (): Row[] =>
    db.prepare('SELECT * FROM listings ORDER BY id').all().map(hydrate);

  function findRow(ref: string): Row | null {
    const byId = /^\d+$/.test(ref)
      ? db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(ref))
      : null;
    if (byId) return hydrate(byId);
    const byUrl = db.prepare('SELECT * FROM listings WHERE url = ?').get(ref);
    return byUrl ? hydrate(byUrl) : null;
  }

  function saveListing(url: string, listing: Listing, score: Score): Row {
    const ts = nowIso();
    db.prepare(
      `INSERT INTO listings (url, listing, score, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET listing = excluded.listing,
                                      score   = excluded.score,
                                      updated_at = excluded.updated_at`
    ).run(url, JSON.stringify(listing), JSON.stringify(score), ts, ts);
    const saved = findRow(url)!;
    bb.realtime.publish(LISTINGS_CHANGED, { id: saved.id });
    return saved;
  }

  // ----------------------------------------------------------------- models
  /**
   * Every model BB can currently reach. The models call is per-provider — with
   * no providerId it answers nothing — so ask each available provider and merge.
   */
  async function availableModels(signal?: AbortSignal): Promise<ModelOption[]> {
    const providers = await bb.sdk.providers.list({ signal });
    const out: ModelOption[] = [];
    for (const provider of providers) {
      if (!provider.available) continue;
      try {
        const res = await bb.sdk.providers.models({ providerId: provider.id, signal });
        for (const m of res.models ?? []) {
          out.push({
            ...(m as unknown as ModelOption),
            providerId: provider.id,
            providerName: provider.displayName,
          });
        }
      } catch (err) {
        // A provider that cannot list models simply offers none.
        bb.log.debug(`models unavailable for ${provider.id}: ${String(err)}`);
      }
    }
    return out;
  }

  /** Provider-qualified id, since model ids are only unique within a provider. */
  const modelRef = (m: ModelOption) => `${m.providerId}/${m.id}`;

  /**
   * Resolve a model the user named, or the configured one, or BB's default.
   * Accepts an exact id, or a unique case-insensitive substring of the id or
   * display name, so `bb real-estate evaluate 3 --model opus` works.
   */
  async function resolveModel(
    requested: string | undefined,
    signal?: AbortSignal
  ): Promise<{ model: ModelOption | null; models: ModelOption[]; note: string }> {
    const models = await availableModels(signal);
    const wanted = (requested ?? (await settings.get()).evaluationModel ?? '').trim();

    if (!wanted) {
      const fallback = models.find((m) => m.isDefault) ?? models[0] ?? null;
      return {
        model: fallback,
        models,
        note: fallback
          ? `no model configured, using BB's default (${modelRef(fallback)})`
          : 'no models available',
      };
    }

    const exact = models.find((m) => modelRef(m) === wanted || m.id === wanted);
    if (exact) return { model: exact, models, note: `using ${modelRef(exact)}` };

    const needle = wanted.toLowerCase();
    const fuzzy = models.filter(
      (m) =>
        modelRef(m).toLowerCase().includes(needle) ||
        m.displayName.toLowerCase().includes(needle)
    );
    if (fuzzy.length === 1) {
      return { model: fuzzy[0]!, models, note: `matched ${modelRef(fuzzy[0]!)}` };
    }
    if (fuzzy.length > 1) {
      throw new Error(
        `"${wanted}" matches ${fuzzy.length} models: ${fuzzy.map(modelRef).join(', ')}. Be more specific.`
      );
    }
    throw new Error(
      `No model matches "${wanted}". Available: ${models.map(modelRef).join(', ') || '(none)'}`
    );
  }

  async function resolveProjectId(ctxProjectId?: string): Promise<string> {
    const configured = (await settings.get()).evaluationProject;
    if (typeof configured === 'string' && configured) return configured;
    if (ctxProjectId) return ctxProjectId;
    const projects = await bb.sdk.projects.list();
    if (projects[0]?.id) return projects[0].id;
    throw new Error(
      'No project to run the evaluation in. Set the "Project for evaluation threads" setting.'
    );
  }

  // ------------------------------------------------------------- the browser
  /**
   * Chrome must run where the caller is. A CLI command executes on the server,
   * which on an enrolled remote machine is not the machine holding the user's
   * browser profile, so route the host call by the invoking thread's host.
   */
  async function resolveHostId(
    threadId: string | undefined,
    signal?: AbortSignal
  ): Promise<string> {
    if (threadId) {
      const thread = await bb.sdk.threads.get({ threadId, signal });
      const environmentId = (thread as { environmentId?: string }).environmentId;
      if (environmentId) {
        const env = await bb.sdk.environments.get({ environmentId, signal });
        if (env.hostId) return env.hostId;
      }
    }
    const hosts = await bb.sdk.hosts.list();
    const first = hosts[0];
    if (!first) throw new Error('No host available to run Chrome on.');
    return first.id;
  }

  async function browserArgs() {
    const { chromePort, chromeBin, chromeProfileDir } = await settings.get();
    return {
      port: Number(chromePort),
      profileDir: String(chromeProfileDir ?? '').trim() || null,
      chromeBin: String(chromeBin ?? '').trim() || null,
    };
  }

  async function fetchAndScore(
    rawUrl: string,
    threadId?: string,
    signal?: AbortSignal
  ): Promise<Row> {
    const url = normaliseUrl(rawUrl);
    const hostId = await resolveHostId(threadId, signal);
    const page = await host.call(
      'fetchListing',
      { url, ...(await browserArgs()) },
      { hostId, signal }
    );
    if (page.blocked) {
      throw new Error(
        page.message ??
          'Idealista served a bot challenge. Solve it in the Chrome window that just opened, then run the command again.'
      );
    }
    const listing = parseListing(page.text, {
      url,
      title: page.title,
      structured: page.structured ?? null,
    });
    if (!listing.price) {
      throw new Error(
        'Read the page but found no price — the listing may be withdrawn, or Idealista changed its layout.'
      );
    }
    return saveListing(url, listing, scoreListing(listing));
  }

  // ---------------------------------------------------------- the evaluation
  /**
   * Ask the chosen model to second-guess the local score. The prompt is
   * self-contained and runs in a hidden thread, so this works with whichever
   * provider backs the selected model.
   */
  async function evaluate(
    row: Row,
    requestedModel: string | undefined,
    ctxProjectId: string | undefined,
    signal?: AbortSignal
  ): Promise<ModelVerdict> {
    const { model } = await resolveModel(requestedModel, signal);
    if (!model) throw new Error('No provider models are available to evaluate with.');

    const projectId = await resolveProjectId(ctxProjectId);
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: 'project-default' },
      prompt: buildPrompt({ listing: row.listing, score: row.score }),
      providerId: model.providerId,
      model: model.id,
      title: `Evaluate ${row.listing.title || row.url}`,
      visibility: 'hidden',
    });

    await bb.sdk.threads.wait({
      threadId: thread.id,
      status: 'idle',
      timeoutMs: 10 * 60_000,
      signal,
    });
    const { output } = await bb.sdk.threads.output({ threadId: thread.id, signal });
    const text = (output ?? '').trim();

    const verdict: ModelVerdict = {
      modelId: modelRef(model),
      providerId: model.providerId,
      score: extractScore(text),
      text,
      threadId: thread.id,
      at: nowIso(),
    };
    db.prepare('UPDATE listings SET verdict = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(verdict),
      nowIso(),
      row.id
    );
    bb.realtime.publish(LISTINGS_CHANGED, { id: row.id });
    return verdict;
  }

  // ------------------------------------------------------------- formatting
  function summarise(row: Row): string {
    const s = row.score;
    const e = s.economics;
    const lines = [
      `#${row.id}  ${row.listing.title || row.url}`,
      `  ${s.district?.name ?? 'district unmatched'} · ${eur(row.listing.price)} · ${row.listing.builtM2 ?? '?'} m² · ${eur(e.pricePerM2)}/m²`,
      `  score ${s.overall.toFixed(1)} — ${s.verdict}${row.verdict?.score != null ? `   model ${row.verdict.score.toFixed(1)} (${row.verdict.modelId})` : ''}`,
      `  rent ${eur(e.realisticRent)}/mo · gross ${e.grossYield ?? '—'}% · fair ${eur(e.fairPrice)} → ${e.priceVerdict ?? '—'}`,
    ];
    if (s.risks.length) lines.push(`  risks: ${s.risks.map((r) => r.label).join(', ')}`);
    return lines.join('\n');
  }

  function detail(row: Row): string {
    const s = row.score;
    const e = s.economics;
    const out = [summarise(row), '', 'Dimensions:'];
    for (const [k, v] of Object.entries(s.dims)) {
      out.push(`  ${k.padEnd(14)} ${v == null ? 'n/a' : v.toFixed(1)}`);
    }
    if (s.risks.length) {
      out.push('', 'Risks:');
      for (const r of s.risks) out.push(`  ${r.label} (−${r.penalty}) — ${r.why}`);
    }
    if (e.bands) {
      out.push(
        '',
        'What to pay:',
        `  excellent ≤ ${eur(e.bands.excellent)}`,
        `  very good ≤ ${eur(e.bands.veryGood)}`,
        `  good      ≤ ${eur(e.bands.good)}`,
        `  negotiate ≤ ${eur(e.bands.negotiate)}`
      );
    }
    out.push('', 'Before you offer:');
    for (const c of s.checklist) out.push(`  - ${c}`);
    if (s.notes.length) out.push('', ...s.notes.map((n) => `note: ${n}`));
    if (row.verdict) {
      out.push(
        '',
        `Model evaluation — ${row.verdict.modelId}${row.verdict.score != null ? ` · ${row.verdict.score.toFixed(1)}/10` : ''} (${row.verdict.at})`,
        row.verdict.text
      );
    }
    return out.join('\n');
  }

  // -------------------------------------------------------------------- RPC
  // The panel in app.tsx talks to these; the CLI above shares the same helpers.
  bb.rpc.register(rpcContract, {
    listings_list() {
      return { listings: allRows().sort((a, b) => b.score.overall - a.score.overall) };
    },

    async listings_add({ url, askModel, model }) {
      const row = await fetchAndScore(url);
      if (askModel === false) return { listing: row };
      const auto = (await settings.get()).autoEvaluate;
      if (!auto && askModel !== true) return { listing: row };
      await evaluate(row, model, undefined);
      return { listing: findRow(String(row.id))! };
    },

    async listings_evaluate({ id, model }) {
      const row = findRow(String(id));
      if (!row) throw new Error(`No listing ${id}.`);
      await evaluate(row, model, undefined);
      return { listing: findRow(String(id))! };
    },

    listings_remove({ id }) {
      const removed = db.prepare('DELETE FROM listings WHERE id = ?').run(id).changes > 0;
      if (removed) bb.realtime.publish(LISTINGS_CHANGED, { id });
      return { removed };
    },

    async models_list() {
      const models = await availableModels();
      return {
        models: models.map((m) => ({
          id: m.id,
          ref: modelRef(m),
          displayName: m.displayName,
          description: m.description,
          providerId: m.providerId,
          providerName: m.providerName,
          isDefault: m.isDefault,
        })),
        selected: String((await settings.get()).evaluationModel ?? ''),
      };
    },

    async model_select({ ref }) {
      const { model } = await resolveModel(ref);
      if (!model) throw new Error('No models available.');
      await settings.experimental_set({ evaluationModel: modelRef(model) });
      return { selected: modelRef(model) };
    },
  });

  // -------------------------------------------------------------------- CLI
  bb.cli.register({
    name: 'real-estate',
    summary: 'Score Idealista listings and have a model you choose second-guess the score',
    commands: [
      { name: 'models', summary: 'List the evaluation models BB can reach', usage: 'bb real-estate models' },
      { name: 'use-model', summary: 'Choose the evaluation model', usage: 'bb real-estate use-model <model-id>' },
      { name: 'add', summary: 'Read a listing, score it, and evaluate it', usage: 'bb real-estate add <idealista-url> [--model <id>] [--no-ai]' },
      { name: 'list', summary: 'Show the scored shortlist, best first', usage: 'bb real-estate list' },
      { name: 'show', summary: 'Full breakdown for one listing', usage: 'bb real-estate show <id|url>' },
      { name: 'evaluate', summary: 'Ask a model about a listing already added', usage: 'bb real-estate evaluate <id|url> [--model <id>]' },
      { name: 'remove', summary: 'Drop a listing', usage: 'bb real-estate remove <id|url>' },
      { name: 'import', summary: "Import the standalone app's listings", usage: 'bb real-estate import <path-to-listings.db>' },
    ],

    async run(argv, ctx) {
      const flag = (name: string): string | undefined => {
        const i = argv.indexOf(`--${name}`);
        return i >= 0 ? argv[i + 1] : undefined;
      };
      const has = (name: string) => argv.includes(`--${name}`);
      const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
      const [command, arg] = positional;

      try {
        switch (command) {
          case 'use-model': {
            if (!arg) return { exitCode: 2, stderr: 'Usage: bb real-estate use-model <model-id>' };
            const { model } = await resolveModel(arg, ctx.signal);
            if (!model) return { exitCode: 1, stderr: 'No models available.' };
            await settings.experimental_set({ evaluationModel: modelRef(model) });
            return {
              exitCode: 0,
              stdout: `Evaluation model set to ${modelRef(model)} (${model.displayName}).`,
            };
          }

          case 'models': {
            const models = await availableModels(ctx.signal);
            if (!models.length) {
              return { exitCode: 1, stderr: 'BB reports no available models. Check your provider setup.' };
            }
            const chosen = (await settings.get()).evaluationModel;
            const lines = models.map((m) => {
              const ref = modelRef(m);
              const mark = ref === chosen || m.id === chosen ? '*' : m.isDefault && !chosen ? '·' : ' ';
              return `${mark} ${ref.padEnd(42)} ${m.displayName}`;
            });
            lines.push('', '* = selected   · = BB default (used when none selected)');
            lines.push('Choose one with: bb real-estate use-model <model-id>');
            return { exitCode: 0, stdout: lines.join('\n') };
          }

          case 'add': {
            if (!arg) return { exitCode: 2, stderr: 'Usage: bb real-estate add <idealista-url>' };
            const row = await fetchAndScore(arg, ctx.threadId, ctx.signal);
            const parts = [summarise(row)];
            const auto = (await settings.get()).autoEvaluate;
            if (!has('no-ai') && auto) {
              const verdict = await evaluate(row, flag('model'), ctx.projectId, ctx.signal);
              parts.push(
                '',
                `Model ${verdict.modelId} says ${verdict.score != null ? `${verdict.score.toFixed(1)}/10` : '(no score line found)'}.`,
                'See it with: bb real-estate show ' + row.id
              );
            }
            return { exitCode: 0, stdout: parts.join('\n') };
          }

          case 'list': {
            const rows = allRows().sort((a, b) => b.score.overall - a.score.overall);
            if (!rows.length) {
              return { exitCode: 0, stdout: 'Nothing yet. Add one: bb real-estate add <idealista-url>' };
            }
            return { exitCode: 0, stdout: rows.map(summarise).join('\n\n') };
          }

          case 'show': {
            if (!arg) return { exitCode: 2, stderr: 'Usage: bb real-estate show <id|url>' };
            const row = findRow(arg);
            if (!row) return { exitCode: 1, stderr: `No listing ${arg}.` };
            return { exitCode: 0, stdout: detail(row) };
          }

          case 'evaluate': {
            if (!arg) return { exitCode: 2, stderr: 'Usage: bb real-estate evaluate <id|url> [--model <id>]' };
            const row = findRow(arg);
            if (!row) return { exitCode: 1, stderr: `No listing ${arg}. Add it first.` };
            const verdict = await evaluate(row, flag('model'), ctx.projectId, ctx.signal);
            return {
              exitCode: 0,
              stdout: [
                `${verdict.modelId} — ${verdict.score != null ? `${verdict.score.toFixed(1)}/10` : 'no score line found'} (local score ${row.score.overall.toFixed(1)})`,
                '',
                verdict.text,
              ].join('\n'),
            };
          }

          case 'import': {
            if (!arg) {
              return {
                exitCode: 2,
                stderr: 'Usage: bb real-estate import <path-to-listings.db>',
              };
            }
            const hostId = await resolveHostId(ctx.threadId, ctx.signal);
            const { rows } = await host.call(
              'readLegacyDb',
              { path: arg },
              { hostId, signal: ctx.signal }
            );
            let added = 0;
            let updated = 0;
            for (const r of rows) {
              const listing = JSON.parse(r.listing) as Listing;
              const existed = Boolean(findRow(r.url));
              const saved = saveListing(r.url, listing, scoreListing(listing));
              existed ? updated++ : added++;
              if (r.verdictText) {
                const verdict: ModelVerdict = {
                  modelId: 'imported/chatgpt',
                  providerId: 'imported',
                  score: r.verdictScore,
                  text: r.verdictText,
                  threadId: '',
                  at: r.verdictAt ?? nowIso(),
                };
                db.prepare(
                  'UPDATE listings SET verdict = ?, updated_at = ? WHERE id = ?'
                ).run(JSON.stringify(verdict), nowIso(), saved.id);
              }
            }
            bb.realtime.publish(LISTINGS_CHANGED, { imported: rows.length });
            return {
              exitCode: 0,
              stdout: `Imported ${rows.length} listings (${added} new, ${updated} updated). Scores recomputed with this plugin's config.`,
            };
          }

          case 'remove': {
            if (!arg) return { exitCode: 2, stderr: 'Usage: bb real-estate remove <id|url>' };
            const row = findRow(arg);
            if (!row) return { exitCode: 1, stderr: `No listing ${arg}.` };
            db.prepare('DELETE FROM listings WHERE id = ?').run(row.id);
            bb.realtime.publish(LISTINGS_CHANGED, { id: row.id });
            return { exitCode: 0, stdout: `Removed #${row.id}.` };
          }

          default:
            return {
              exitCode: 2,
              stderr: [
                'Usage:',
                '  bb real-estate models                            list evaluation models',
                '  bb real-estate use-model <model-id>             choose one',
                '  bb real-estate add <url> [--model <id>] [--no-ai]',
                '  bb real-estate list',
                '  bb real-estate show <id|url>',
                '  bb real-estate evaluate <id|url> [--model <id>]',
                '  bb real-estate remove <id|url>',
                '  bb real-estate import <path-to-listings.db>',
              ].join('\n'),
            };
        }
      } catch (err) {
        return { exitCode: 1, stderr: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  // ------------------------------------------------------------- agent tool
  bb.agents.registerTool({
    name: 'real_estate_score_listing',
    description:
      'Read an Idealista property listing, score it 0-10 as a buy-to-let investment against local district benchmarks, and optionally have a chosen model second-guess that score.',
    instructions:
      'Use real_estate_score_listing for Idealista URLs instead of trying to fetch them; Idealista blocks non-browser clients.',
    presentation: {
      label: { pending: 'Scoring the listing', completed: 'Scored the listing' },
    },
    parameters: z.object({
      url: z.string().min(1).describe('The idealista.com listing URL'),
      model: z
        .string()
        .optional()
        .describe('Model to evaluate with; omit to use the configured or default model'),
      askModel: z
        .boolean()
        .optional()
        .describe('Ask a model to second-guess the deterministic score (default true)'),
    }),
    async execute({ url, model, askModel }, { threadId, projectId, signal }) {
      try {
        const row = await fetchAndScore(url, threadId ?? undefined, signal ?? undefined);
        if (askModel === false) return detail(row);
        const verdict = await evaluate(row, model, projectId ?? undefined, signal ?? undefined);
        return `${detail(row)}\n\n--- ${verdict.modelId} ---\n${verdict.text}`;
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  });

  bb.log.info(
    `ready — ${scoringConfig.districts.length} ${scoringConfig.city} districts, ${allRows().length} listings stored`
  );
}
