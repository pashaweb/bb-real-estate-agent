// The full breakdown for one listing: the same content the standalone app
// showed in its drawer, and `bb real-estate show` prints.

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { districtTone, eur, pct, scoreTone } from '@/lib/format';
import type { Row } from '../server';

const DIMENSIONS: [string, string][] = [
  ['location', 'Location'],
  ['rentalDemand', 'Rental demand'],
  ['price', 'Purchase price'],
  ['resale', 'Resale'],
  ['building', 'Building'],
  ['safety', 'Area safety'],
  ['yield', 'Gross yield'],
];

export function ListingDetail({
  row,
  onClose,
  onEvaluate,
  onRemove,
  busy,
}: {
  row: Row | null;
  onClose: () => void;
  onEvaluate: () => void;
  onRemove: () => void;
  busy: boolean;
}) {
  if (!row) return null;
  const { listing, score } = row;
  const e = score.economics;
  const d = score.district;
  const bands = e.bands;

  const band = (label: string, value: string) => (
    <div
      key={label}
      className={`flex justify-between rounded-md px-2.5 py-1.5 text-xs ${
        e.priceVerdict === label ? 'ring-1 ring-primary' : 'bg-muted/50'
      }`}
    >
      <span>{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );

  return (
    <Dialog open={Boolean(row)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="pr-8 text-base">
            {listing.title || row.url}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              {d ? (
                <>
                  <span
                    className={`inline-block size-2 rounded-full ${districtTone(d.flag)}`}
                  />
                  <span>{d.name}</span>
                  <span>· {eur(d.salePerM2)}/m² · {d.rentPerM2} €/m²/mo</span>
                </>
              ) : (
                <span>District not matched</span>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3">
          <span
            className={`rounded-md px-2 py-0.5 text-lg font-bold tabular-nums ${scoreTone(score.overall)}`}
          >
            {score.overall.toFixed(1)}
          </span>
          <span className="text-xs font-semibold tracking-wide">
            {score.verdict}
          </span>
          {row.verdict?.score != null && (
            <span className="text-xs text-muted-foreground">
              · {row.verdict.modelId} says {row.verdict.score.toFixed(1)}
            </span>
          )}
          <a
            href={row.url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-xs text-primary hover:underline"
          >
            open on Idealista ↗
          </a>
        </div>

        {d?.note && (
          <p className="text-xs text-muted-foreground">{d.note}</p>
        )}

        <Section title="Score breakdown">
          <div className="grid gap-1.5">
            {DIMENSIONS.map(([key, label]) => {
              const v = score.dims[key];
              return (
                <div
                  key={key}
                  className="grid grid-cols-[7rem_1fr_2.2rem] items-center gap-2 text-xs"
                >
                  <span className="text-muted-foreground">{label}</span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-primary"
                      style={{ width: `${v == null ? 0 : v * 10}%` }}
                    />
                  </span>
                  <span className="text-right tabular-nums">
                    {v == null ? 'n/a' : v.toFixed(1)}
                  </span>
                </div>
              );
            })}
          </div>
        </Section>

        {score.risks.length > 0 && (
          <Section title="Risks">
            {score.risks.map((r) => (
              <div
                key={r.label}
                className="mb-1.5 rounded-r-md border-l-2 border-red-500 bg-muted/50 px-2.5 py-1.5 text-xs"
              >
                <b className="text-red-600 dark:text-red-400">{r.label}</b> −
                {r.penalty} · {r.why}
              </div>
            ))}
          </Section>
        )}

        <Section title="Economics">
          <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-xs">
            <Row label="Asking price" value={eur(listing.price)} />
            <Row
              label="€/m²"
              value={`${eur(e.pricePerM2)} vs district ${eur(e.benchmarkPerM2)} → ${
                e.discountPct == null ? '—' : pct(-e.discountPct)
              }`}
            />
            <Row label="District avg rent" value={`${eur(e.marketRent)}/mo`} />
            <Row
              label="Underwritten rent"
              value={`${eur(e.realisticRent)}/mo ${(e.rentAdjustments ?? []).join(', ')}`}
            />
            <Row
              label="Gross yield"
              value={`${e.grossYield ?? '—'}% on asking · ${e.yieldOnAllIn ?? '—'}% all-in`}
            />
            <Row label="All-in cost" value={eur(e.allInCost)} />
            {listing.communityFee ? (
              <Row label="Community" value={`${eur(listing.communityFee)}/mo`} />
            ) : null}
          </dl>
        </Section>

        {bands && (
          <Section title="What I would pay">
            <div className="grid gap-1">
              {band('EXCELLENT', `≤ ${eur(bands.excellent)}`)}
              {band('VERY GOOD', `≤ ${eur(bands.veryGood)}`)}
              {band('GOOD / REASONABLE', `≤ ${eur(bands.good)}`)}
              {band('NEGOTIATE HARD', `≤ ${eur(bands.negotiate)}`)}
              {band('MOVE ON', `> ${eur(bands.negotiate)}`)}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Asking <b>{eur(listing.price)}</b> → <b>{e.priceVerdict ?? '—'}</b>.
              Fair price {eur(e.fairPrice)} = 55% yield anchor + 45% district
              benchmark × {e.qualityFactor} unit quality.
            </p>
          </Section>
        )}

        <Section title="Before you offer">
          <ul className="list-disc space-y-1 pl-4 text-xs">
            {score.checklist.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Section>

        {score.notes.length > 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {score.notes.join(' · ')}
          </p>
        )}

        {row.verdict && (
          <Section
            title={`Model evaluation — ${row.verdict.modelId}${
              row.verdict.score != null ? ` · ${row.verdict.score.toFixed(1)}/10` : ''
            }`}
          >
            <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-muted-foreground">
              {row.verdict.text}
            </pre>
          </Section>
        )}

        <div className="flex gap-2 pt-1">
          <Button size="sm" onClick={onEvaluate} disabled={busy}>
            {row.verdict ? 'Ask again' : 'Ask the model'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-red-600 dark:text-red-400"
            onClick={onRemove}
            disabled={busy}
          >
            Remove
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1.5 mt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0">{value}</dd>
    </>
  );
}
