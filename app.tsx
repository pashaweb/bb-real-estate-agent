// The Listings panel: the standalone app's table, rebuilt on BB's RPC and
// theme. Paste an Idealista URL, it is read through your Chrome, scored, and
// ranked; clicking a row opens the full breakdown.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { definePluginApp, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ListingDetail } from '@/components/listing-detail';
import { districtTone, eur, pct, scoreTone } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Row, rpcContract } from './server';

type SortKey =
  | 'overall'
  | 'model'
  | 'title'
  | 'district'
  | 'price'
  | 'm2'
  | 'perM2'
  | 'discount'
  | 'rent'
  | 'yield'
  | 'fair';

const COLUMNS: { key: SortKey | null; label: string; numeric?: boolean; title?: string }[] = [
  { key: 'overall', label: 'Score', numeric: true },
  { key: 'model', label: 'Model', numeric: true, title: 'Score from the evaluating model' },
  { key: null, label: 'Verdict' },
  { key: 'title', label: 'Property' },
  { key: 'district', label: 'District' },
  { key: 'price', label: 'Price', numeric: true },
  { key: 'm2', label: 'm²', numeric: true },
  { key: 'perM2', label: '€/m²', numeric: true },
  { key: 'discount', label: 'vs area', numeric: true, title: 'Against the district asking-price indicator' },
  { key: null, label: 'Lift' },
  { key: null, label: 'Heat' },
  { key: 'rent', label: 'Rent est.', numeric: true },
  { key: 'yield', label: 'Yield', numeric: true },
  { key: 'fair', label: 'Fair px', numeric: true },
];

const sortValue = (r: Row, key: SortKey): number | string => {
  const e = r.score.economics;
  switch (key) {
    case 'model':
      return r.verdict?.score ?? -1;
    case 'title':
      return (r.listing.title ?? '').toLowerCase();
    case 'district':
      return (r.score.district?.name ?? 'zzz').toLowerCase();
    case 'price':
      return r.listing.price ?? 0;
    case 'm2':
      return r.listing.builtM2 ?? 0;
    case 'perM2':
      return e.pricePerM2 ?? 0;
    case 'discount':
      return e.discountPct ?? -999;
    case 'rent':
      return e.realisticRent ?? 0;
    case 'yield':
      return e.grossYield ?? 0;
    case 'fair':
      return e.fairPrice ?? 0;
    default:
      return r.score.overall;
  }
};

const tick = (v: boolean | null | undefined) =>
  v === true ? (
    <span className="text-emerald-600 dark:text-emerald-400">✓</span>
  ) : v === false ? (
    <span className="text-red-600 dark:text-red-400">✗</span>
  ) : (
    <span className="text-muted-foreground">?</span>
  );

function ListingsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [models, setModels] = useState<{ ref: string; displayName: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'overall', dir: -1 });

  const report = useCallback((cause: unknown) => {
    setStatus({ text: cause instanceof Error ? cause.message : String(cause), tone: 'error' });
  }, []);

  const refetch = useCallback(() => {
    rpc.call('listings_list').then((r) => setRows(r.listings), report);
  }, [rpc, report]);

  useEffect(() => {
    refetch();
    rpc.call('models_list').then((r) => {
      setModels(r.models);
      setSelectedModel(r.selected);
    }, report);
  }, [rpc, refetch, report]);

  // server.ts publishes after every write — from here, the CLI, or an agent.
  useRealtime('listings-changed', refetch);

  const sorted = useMemo(() => {
    const list = [...(rows ?? [])];
    list.sort((a, b) => {
      const [x, y] = [sortValue(a, sort.key), sortValue(b, sort.key)];
      const cmp = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number);
      return cmp * sort.dir;
    });
    return list;
  }, [rows, sort]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setStatus({ text: label, tone: 'info' });
    try {
      await fn();
      setStatus(null);
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    const value = url.trim();
    if (!value) return;
    void run('Opening the listing in Chrome…', async () => {
      const { listing } = await rpc.call('listings_add', { url: value });
      setUrl('');
      refetch();
      setOpenId(listing.id);
    });
  };

  const openRow = sorted.find((r) => r.id === openId) ?? null;

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <form onSubmit={add} className="flex gap-2">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.idealista.com/inmueble/112436659/"
          spellCheck={false}
          className="font-mono text-xs"
        />
        <Button type="submit" disabled={busy || !url.trim()}>
          Add listing
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <label className="flex items-center gap-1.5">
          Evaluated by
          <select
            value={selectedModel}
            disabled={busy}
            onChange={(e) => {
              const ref = e.target.value;
              setSelectedModel(ref);
              void run('Selecting model…', () => rpc.call('model_select', { ref }));
            }}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
          >
            {selectedModel === '' && <option value="">BB default</option>}
            {models.map((m) => (
              <option key={m.ref} value={m.ref}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto">
          {rows ? `${rows.length} listing${rows.length === 1 ? '' : 's'}` : 'loading…'}
        </span>
      </div>

      {status && (
        <div
          className={cn(
            'rounded-md border px-3 py-2 text-xs',
            status.tone === 'error'
              ? 'border-red-500/40 text-red-600 dark:text-red-400'
              : 'border-border text-muted-foreground'
          )}
        >
          {status.text}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="sticky top-0 bg-muted/60 px-2 py-2 text-right font-semibold text-muted-foreground">
                #
              </th>
              {COLUMNS.map((c) => (
                <th
                  key={c.label}
                  title={c.title}
                  onClick={() =>
                    c.key &&
                    setSort((s) =>
                      s.key === c.key
                        ? { key: c.key!, dir: (s.dir * -1) as 1 | -1 }
                        : { key: c.key!, dir: c.key === 'title' || c.key === 'district' ? 1 : -1 }
                    )
                  }
                  className={cn(
                    'sticky top-0 whitespace-nowrap bg-muted/60 px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
                    c.numeric ? 'text-right' : 'text-left',
                    c.key && 'cursor-pointer hover:text-foreground'
                  )}
                >
                  {c.label}
                  {sort.key === c.key && (sort.dir === -1 ? ' ↓' : ' ↑')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => {
              const e = r.score.economics;
              const d = r.score.district;
              return (
                <tr
                  key={r.id}
                  onClick={() => setOpenId(r.id)}
                  className="cursor-pointer border-t border-border hover:bg-state-hover"
                >
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                    {i + 1}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 font-bold tabular-nums',
                        scoreTone(r.score.overall)
                      )}
                    >
                      {r.score.overall.toFixed(1)}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {r.verdict?.score != null ? (
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 font-bold tabular-nums',
                          scoreTone(r.verdict.score)
                        )}
                        title={r.verdict.modelId}
                      >
                        {r.verdict.score.toFixed(1)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="max-w-52 px-2 py-1.5">
                    <div className="text-[11px] font-semibold leading-tight">
                      {r.score.verdict}
                    </div>
                    {r.score.risks.length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {r.score.risks.slice(0, 2).map((risk) => (
                          <span
                            key={risk.label}
                            title={risk.why}
                            className="rounded-full border border-red-500/40 px-1.5 text-[9px] text-red-600 dark:text-red-400"
                          >
                            {risk.label}
                          </span>
                        ))}
                        {r.score.risks.length > 2 && (
                          <span className="rounded-full border border-red-500/40 px-1.5 text-[9px] text-red-600 dark:text-red-400">
                            +{r.score.risks.length - 2}
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="max-w-56 truncate px-2 py-1.5 font-semibold">
                    {r.listing.title || r.url}
                  </td>
                  <td className="max-w-44 truncate px-2 py-1.5">
                    {d ? (
                      <>
                        <span
                          className={cn('mr-1.5 inline-block size-1.5 rounded-full', districtTone(d.flag))}
                        />
                        {d.name}
                      </>
                    ) : (
                      <span className="text-muted-foreground">unmatched</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                    {eur(r.listing.price)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.listing.builtM2 ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{eur(e.pricePerM2)}</td>
                  <td
                    className={cn(
                      'px-2 py-1.5 text-right tabular-nums',
                      e.discountPct != null &&
                        (e.discountPct > 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-red-600 dark:text-red-400')
                    )}
                  >
                    {e.discountPct == null ? '—' : pct(-e.discountPct)}
                  </td>
                  <td className="px-2 py-1.5 text-center">{tick(r.listing.elevator)}</td>
                  <td className="px-2 py-1.5 text-center">{tick(r.listing.heating)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{eur(e.realisticRent)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {e.grossYield == null ? '—' : `${e.grossYield}%`}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{eur(e.fairPrice)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows?.length === 0 && (
          <p className="p-8 text-center text-xs text-muted-foreground">
            Nothing here yet — paste an Idealista listing URL above.
          </p>
        )}
      </div>

      <ListingDetail
        row={openRow}
        busy={busy}
        onClose={() => setOpenId(null)}
        onEvaluate={() =>
          openRow &&
          void run('Asking the model…', () => rpc.call('listings_evaluate', { id: openRow.id }))
        }
        onRemove={() =>
          openRow &&
          void run('Removing…', async () => {
            await rpc.call('listings_remove', { id: openRow.id });
            setOpenId(null);
          })
        }
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: 'listings',
    title: 'Listings',
    icon: 'Home',
    path: 'listings',
    component: ListingsPanel,
  });
});
