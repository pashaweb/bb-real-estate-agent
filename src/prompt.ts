import type { Listing, Score } from './types.js';

// Builds a self-contained prompt asking a model to second-guess the local score.
// Everything is inlined: the evaluating model runs in its own thread with no
// access to this plugin's database, and cannot open the Idealista page either
// (Idealista 403s non-browser clients).

const eur = (n: number | null | undefined) => (n == null ? 'not stated' : `€${Math.round(n).toLocaleString('es-ES')}`);
const yn = (v: boolean | null | undefined) => (v === true ? 'yes' : v === false ? 'no' : 'not stated');

const line = (label: string, value: string | number | null | undefined) => (value == null || value === '' ? null : `- **${label}:** ${value}`);

export function buildPrompt(row: { listing: Listing; score: Score }): string {
  const l = row.listing;
  const s = row.score;
  const e = s.economics;
  const d = s.district;

  const facts = [
    line('Price', eur(l.price) + (l.previousPrice ? ` (was ${eur(l.previousPrice)}, −${l.priceDropPct}%)` : '')),
    line('Size', l.builtM2 ? `${l.builtM2} m² built${l.usefulM2 ? ` / ${l.usefulM2} m² useful` : ''}` : null),
    line('Price per m²', e.pricePerM2 ? `${eur(e.pricePerM2)}/m²` : null),
    line('Bedrooms / bathrooms', `${l.bedrooms ?? '?'} / ${l.bathrooms ?? '?'}`),
    line('Floor', l.floor === 0 ? 'ground floor' : l.floor != null ? `${l.floor}` : null),
    line('Exterior', yn(l.exterior)),
    line('Elevator', yn(l.elevator)),
    line('Heating', l.heating === false ? 'NONE INSTALLED' : l.heatingType || yn(l.heating)),
    line('Year built', l.yearBuilt),
    line('Condition', l.condition),
    line('Terrace / storage / garage', `${yn(l.terrace)} / ${yn(l.storage)} / ${yn(l.garage)}${l.garagePrice ? ` (garage ${eur(l.garagePrice)} extra)` : ''}`),
    line('Community fee', l.communityFee ? `${eur(l.communityFee)}/month` : null),
    line('Listing flags', Object.entries(l.flags ?? {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none detected'),
  ].filter(Boolean).join('\n');

  const districtBlock = d
    ? `The district is **${d.name}**. My reference figures for it: asking prices around ${eur(d.salePerM2)}/m², rents around ${d.rentPerM2} €/m²/month. Note: ${d.note}`
    : `I could not match the neighbourhood ("${l.neighbourhood ?? 'unknown'}") to a district I have figures for.`;

  const myWorking = [
    e.discountPct != null ? `- vs district asking price: **${e.discountPct > 0 ? `${e.discountPct}% below` : `${Math.abs(e.discountPct)}% above`}**` : null,
    e.realisticRent ? `- rent I would underwrite: **${eur(e.realisticRent)}/month** (district average ${eur(e.marketRent)}, adjusted for ${(e.rentAdjustments ?? []).join(', ') || 'nothing'})` : null,
    e.grossYield != null ? `- gross yield: **${e.grossYield}%** on the asking price, ${e.yieldOnAllIn}% on all-in cost` : null,
    e.allInCost ? `- all-in cost: **${eur(e.allInCost)}** (${(e.costItems ?? []).map((c) => `${c.label} ${eur(c.amount)}`).join(', ')})` : null,
    e.fairPrice ? `- my fair price: **${eur(e.fairPrice)}** → I call ${eur(l.price)} **${e.priceVerdict}**` : null,
    `- my overall score: **${s.overall}/10 — ${s.verdict}**`,
    s.risks.length ? `- risks I flagged: ${s.risks.map((r) => r.label).join(', ')}` : null,
  ].filter(Boolean).join('\n');

  return `I am evaluating a property in Oviedo, Asturias as a **buy-to-let investment** (buy, renovate if needed, rent, hold 5–10 years).

Listing: ${l.url}

## What the advertisement says

${facts}

${l.description ? `Description (verbatim from the ad):\n\n> ${l.description.replace(/\n+/g, ' ')}\n` : ''}
## District context

${districtBlock}

## My own analysis (please challenge it)

${myWorking}

## What I want from you

Please check current market data for this street and district, then give me:

1. **A rating out of 10 as an investment**, and whether you would shortlist it or pass.
2. A breakdown of: location, rental demand, purchase price, resale prospects, the building, and area safety — each out of 10.
3. Your own realistic monthly rent estimate and the resulting gross yield, with your reasoning.
4. **What you would actually pay**: the price at which it becomes excellent / very good / reasonable, and the price above which you would walk away.
5. The specific risks and the things I must verify before making an offer.
6. Where you disagree with my analysis above, and why.

Be concrete about the exact street rather than the district average, and tell me if the advertised price looks misleading for any structural reason (auction, sitting tenant, renta antigua, agency fees on top).

End your reply with a single line in exactly this format so I can record it:

SCORE: X.X/10`;
}

/** Pulls the score out of a pasted reply: the trailing SCORE: line, else any "N/10". */
export function extractScore(text: string | null | undefined): number | null {
  if (!text) return null;
  const tagged = text.match(/SCORE:\s*(\d{1,2}(?:[.,]\d)?)\s*\/\s*10/i);
  const loose = [...text.matchAll(/\b(\d{1,2}(?:[.,]\d)?)\s*\/\s*10\b/g)];
  const raw = tagged?.[1] ?? loose.at(-1)?.[1];
  if (raw == null) return null;
  const n = parseFloat(String(raw).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : null;
}
