// Investment scoring for Oviedo residential listings.
//
// Mirrors the rubric used in the source analysis: six qualitative dimensions
// (location, rental demand, price, resale, building, area safety) plus gross
// yield, weighted into one 0-10 score, then docked for structural risks
// (renta antigua, judicial auction, sitting tenant).

import rawConfig from '../config/oviedo.json';
import type { Listing, Score } from './types.js';

/** District benchmarks, weights and penalties. Editable without touching code. */
export const config = rawConfig;

const clamp = (n: number, lo = 0, hi = 10): number => Math.max(lo, Math.min(hi, n));
const round1 = (n: number): number => Math.round(n * 10) / 10;
const norm = (s: string | null | undefined): string =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

/** Piecewise-linear interpolation over [x, y] breakpoints. */
function curve(points: number[][], x: number): number {
  const first = points[0] as [number, number];
  if (x <= first[0]) return first[1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1] as [number, number];
    const [x1, y1] = points[i] as [number, number];
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return (points.at(-1) as [number, number])[1];
}

const PRICE_CURVE = [
  [-0.2, 2.0],
  [-0.05, 4.0],
  [0, 5.0],
  [0.1, 6.5],
  [0.2, 8.0],
  [0.3, 8.9],
  [0.4, 9.5],
  [0.5, 10],
];
const YIELD_CURVE = [
  [0.02, 1.5],
  [0.03, 2.5],
  [0.04, 4.0],
  [0.05, 5.5],
  [0.06, 7.0],
  [0.07, 8.5],
  [0.08, 9.5],
  [0.09, 10],
];

export function matchDistrict(listing: Listing) {
  const hay = norm(
    [
      listing.neighbourhood,
      listing.title,
      listing.description,
      listing.sourceTitle,
    ].join(' | ')
  );
  let best = null;
  for (const d of config.districts) {
    for (const alias of [d.name, ...(d.aliases ?? [])]) {
      const a = norm(alias);
      if (a.length >= 4 && hay.includes(a) && (!best || a.length > best.len))
        best = { district: d, len: a.length };
    }
  }
  return best?.district ?? null;
}

function microBonuses(listing: Listing) {
  const hay = norm(
    [
      listing.neighbourhood,
      listing.title,
      listing.description,
      listing.sourceTitle,
    ].join(' | ')
  );
  const applied: string[] = [];
  let location = 0;
  let rentalDemand = 0;
  for (const m of config.microLocation) {
    if (m.match.some((k) => hay.includes(norm(k)))) {
      applied.push(m.label);
      location += m.location ?? 0;
      rentalDemand += m.rentalDemand ?? 0;
    }
  }
  // Cap: a district base rating already prices in "it is central"; the micro
  // bonus is only meant to separate streets inside one district.
  return {
    applied,
    location: Math.min(location, 0.5),
    rentalDemand: Math.min(rentalDemand, 0.5),
  };
}

/** Market rent for the unit, and the rent we would actually underwrite. */
function estimateRent(listing: Listing, bench: any) {
  if (!bench || !listing.builtM2)
    return { marketRent: null, realisticRent: null, adjustments: [] };
  const a = config.rentAdjustments;
  const marketRent = bench.rentPerM2 * listing.builtM2;
  let rent = marketRent;
  const adjustments: string[] = [];
  const apply = (factor: number, label: string) => {
    rent *= factor;
    adjustments.push(`${label} ${Math.round((factor - 1) * 100)}%`);
  };

  if (listing.exterior === false) apply(a.interior, 'interior');
  if (listing.elevator === false) apply(a.noElevator, 'no elevator');
  if (listing.heating === false) apply(a.noHeating, 'no heating');
  if (listing.condition === 'needs-renovation')
    apply(a.needsRenovation, 'needs renovation');
  if (listing.elevator === false && (listing.floor ?? 0) >= 3)
    apply(a.highFloorNoElevator, 'high floor, no lift');
  if (listing.builtM2 <= a.smallUnitMaxM2)
    apply(a.smallUnitPremium, 'small unit premium +');

  return {
    marketRent: Math.round(marketRent),
    realisticRent: Math.round(rent),
    adjustments,
  };
}

/** How this unit compares to a typical unit in its district, as a value multiplier. */
function qualityFactor(listing: Listing) {
  let q = 1.0;
  const notes: string[] = [];
  const adj = (delta: number, label: string) => {
    q += delta;
    notes.push(`${label} ${delta > 0 ? '+' : ''}${Math.round(delta * 100)}%`);
  };

  if (listing.elevator === false) adj(-0.15, 'no elevator');
  if (listing.heating === false) adj(-0.06, 'no heating');
  if (listing.exterior === false) adj(-0.05, 'interior');
  if (listing.condition === 'needs-renovation') adj(-0.18, 'needs renovation');
  if (listing.elevator === false && (listing.floor ?? 0) >= 3)
    adj(-0.04, 'high floor, no lift');
  if (listing.terrace) adj(0.03, 'terrace');
  if (listing.storage) adj(0.02, 'storage');
  if (listing.garageIncluded) adj(0.05, 'garage included');
  if (listing.rehabilitatedBuilding) adj(0.05, 'rehabilitated building');
  if (
    listing.usefulM2 &&
    listing.builtM2 &&
    listing.usefulM2 / listing.builtM2 < 0.85
  )
    adj(-0.05, 'low useful/built ratio');
  if (listing.yearBuilt && listing.yearBuilt < 1970)
    adj(-0.04, 'pre-1970 building');
  if (listing.yearBuilt && listing.yearBuilt > 2000)
    adj(0.06, 'post-2000 building');

  return { q: Math.max(0.4, q), notes };
}

function scoreBuilding(listing: Listing): number {
  let s = 7.4;
  if (listing.elevator === true) s += 1.2;
  else if (listing.elevator === false) s -= 1.0;
  if (listing.yearBuilt) {
    if (listing.yearBuilt < 1960) s -= 0.8;
    else if (listing.yearBuilt < 1970) s -= 0.4;
    else if (listing.yearBuilt > 2000) s += 0.8;
  }
  if (listing.condition === 'needs-renovation') s -= 0.5;
  else if (listing.condition === 'good') s += 0.3;
  else if (listing.condition === 'new-build') s += 1.0;
  if (listing.rehabilitatedBuilding) s += 0.5;
  if (listing.terrace) s += 0.3;
  if (listing.storage) s += 0.2;
  if ((listing.bathrooms ?? 0) >= 2) s += 0.3;
  if (listing.heating === false) s -= 0.5;
  if (listing.elevator === false && (listing.floor ?? 0) >= 3) s -= 0.3;
  if (listing.usefulM2 && listing.usefulM2 < 50) s -= 0.8;
  if (
    listing.usefulM2 &&
    listing.builtM2 &&
    listing.usefulM2 / listing.builtM2 < 0.85
  )
    s -= 0.5;
  return clamp(s);
}

function acquisitionCosts(listing: Listing, price: number) {
  const c = config.costs;
  const items: { label: string; amount: number }[] = [];
  const push = (label: string, amount: number) => {
    if (amount > 0) items.push({ label, amount: Math.round(amount) });
  };
  push(`ITP ${Math.round(c.itpRate * 100)}%`, price * c.itpRate);
  push('Notary / registry / gestoría', price * c.notaryRegistryRate);
  if (listing.buyerFeePct)
    push(
      `Buyer agency fee ${listing.buyerFeePct}% + VAT`,
      price * (listing.buyerFeePct / 100) * 1.21
    );
  if (listing.heating === false) push('Install heating', c.heatingInstallCost);
  if (listing.condition === 'needs-renovation' && listing.builtM2)
    push('Renovation', listing.builtM2 * c.renovationCostPerM2);
  else push('Cosmetic / furnishing', c.cosmeticCost);
  return { items, total: items.reduce((a, b) => a + b.amount, 0) };
}

export function scoreListing(listing: Listing): Score {
  const district = matchDistrict(listing);
  const micro = microBonuses(listing);
  const w = config.weights;
  const notes = [];
  const risks: any[] = [];

  const inOviedo = !listing.city || /oviedo/i.test(listing.city);
  // An unrecognised Oviedo district still gets scored, against the city average,
  // rather than losing its price and yield dimensions entirely.
  const bench = district ?? (inOviedo ? config.cityFallback : null);
  if (!inOviedo)
    notes.push(
      `Outside Oviedo (${listing.city}) — district benchmarks do not apply.`
    );
  if (!district && bench) notes.push(bench.note);
  if (district?.estimated)
    notes.push(
      `${district.name} figures are an estimate, not from the source session — sanity-check them before acting on this score.`
    );

  // --- derived numbers ------------------------------------------------------
  const pricePerM2 =
    listing.pricePerM2 ??
    (listing.price && listing.builtM2
      ? Math.round(listing.price / listing.builtM2)
      : null);
  const benchmarkPerM2 = bench?.salePerM2 ?? null;
  const discountPct =
    benchmarkPerM2 && pricePerM2 ? 1 - pricePerM2 / benchmarkPerM2 : null;

  const { marketRent, realisticRent, adjustments } = estimateRent(listing, bench);
  const grossYield =
    realisticRent && listing.price
      ? (realisticRent * 12) / listing.price
      : null;

  const costs = listing.price
    ? acquisitionCosts(listing, listing.price)
    : { items: [], total: 0 };
  const allInCost = listing.price ? listing.price + costs.total : null;
  const yieldOnAllIn =
    realisticRent && allInCost ? (realisticRent * 12) / allInCost : null;

  // --- dimensions -----------------------------------------------------------
  const location = clamp((bench?.location ?? 7.0) + micro.location, 0, 9.5);
  const rentalDemand = clamp(
    (bench?.rentalDemand ?? 7.0) + micro.rentalDemand,
    0,
    9.5
  );
  const safety = clamp(bench?.safety ?? 7.0);
  const price =
    discountPct === null ? null : clamp(curve(PRICE_CURVE, discountPct));
  const building = scoreBuilding(listing);
  const yieldScore =
    grossYield === null ? null : clamp(curve(YIELD_CURVE, grossYield));

  // Weighted mean over the dimensions we could actually compute. An unknown
  // dimension is dropped and its weight redistributed, rather than scored 5.0,
  // so missing data does not silently drag every listing toward the middle.
  const blend = (parts: [number, number | null][], fallback: number): number => {
    const known = parts.filter(
      (part): part is [number, number] => part[1] !== null && part[1] !== undefined
    );
    const total = known.reduce((a, [wt]) => a + wt, 0);
    return total === 0
      ? fallback
      : known.reduce((a, [wt, v]) => a + wt * v, 0) / total;
  };

  let resale = blend(
    [
      [0.45, location],
      [0.35, building],
      [0.2, price],
    ],
    location
  );
  if (listing.elevator === false) resale -= 0.8;
  if (bench?.flag === 'red') resale -= 0.5;
  if ((bench?.rentalDemand ?? 7) < 5) resale -= 0.7;
  resale = clamp(resale);

  const dims = {
    location,
    rentalDemand,
    price,
    resale,
    building,
    safety,
    yield: yieldScore,
  };
  if (price === null)
    notes.push('Price score unavailable: no €/m² benchmark for this district.');
  if (yieldScore === null)
    notes.push('Yield score unavailable: no rent benchmark for this district.');

  let overall = blend(
    [
      [w.location, location],
      [w.rentalDemand, rentalDemand],
      [w.price, price],
      [w.resale, resale],
      [w.building, building],
      [w.safety, safety],
      [w.yield, yieldScore],
    ],
    location
  );

  // --- risk penalties -------------------------------------------------------
  const p = config.riskPenalties;
  const f = listing.flags ?? {};
  const dock = (amount: number, label: string, why: string) => {
    overall -= amount;
    risks.push({ label, penalty: amount, why });
  };

  if (f.auction)
    dock(
      p.auction,
      'Judicial auction',
      'Cesión de remate: indicative price only, no viewing, not mortgageable, needs a lawyer and procurador. The advertised price is not the acquisition cost.'
    );
  if (f.rentaAntigua)
    dock(
      p.rentaAntigua,
      'Renta antigua',
      'Pre-1985 tenancy rules can cap the rent and preserve subrogation rights. Get the contract, the current rent, the original date and 12 months of receipts before offering.'
    );
  else if (f.occupied)
    dock(
      p.occupied,
      'Sitting tenant',
      'Sold with the tenant in place — verify the contract terms and termination date.'
    );
  if (f.buyerAgencyFee || listing.buyerFeePct)
    dock(
      p.buyerAgencyFee,
      'Buyer pays agency fee',
      'Adds several thousand euros on top of the asking price before taxes.'
    );
  if (listing.heating === null)
    dock(
      p.unknownHeating,
      'Heating unknown',
      'The listing does not state a heating system.'
    );
  if (f.aiEditedPhotos)
    dock(
      p.aiEditedPhotos,
      'AI-edited photos',
      'At least one photo is marked "Foto editada con IA" — do not judge condition from the advertisement.'
    );
  // No penalty for simply being elsewhere — the missing benchmarks are already
  // reflected by the dropped dimensions above; it is recorded as a note.

  overall = clamp(round1(overall));

  // --- fair price and negotiation ladder ------------------------------------
  const targetYield = 0.085 - Math.max(0, location - 7) * 0.005;
  const yieldAnchor = realisticRent ? (realisticRent * 12) / targetYield : null;
  const { q, notes: qNotes } = qualityFactor(listing);
  const benchmarkAnchor =
    benchmarkPerM2 && listing.builtM2
      ? benchmarkPerM2 * listing.builtM2 * q
      : null;
  let fairPrice = null;
  if (yieldAnchor && benchmarkAnchor)
    fairPrice = 0.55 * yieldAnchor + 0.45 * benchmarkAnchor;
  else fairPrice = yieldAnchor ?? benchmarkAnchor;
  if (fairPrice && f.rentaAntigua) fairPrice *= 0.8;
  if (fairPrice && f.auction) fairPrice *= 0.7;

  const bands = fairPrice
    ? {
        excellent: Math.round(fairPrice * 0.9),
        veryGood: Math.round(fairPrice * 0.96),
        good: Math.round(fairPrice * 1.04),
        negotiate: Math.round(fairPrice * 1.15),
      }
    : null;

  let priceVerdict = null;
  if (bands && listing.price) {
    if (listing.price <= bands.excellent) priceVerdict = 'EXCELLENT';
    else if (listing.price <= bands.veryGood) priceVerdict = 'VERY GOOD';
    else if (listing.price <= bands.good) priceVerdict = 'GOOD / REASONABLE';
    else if (listing.price <= bands.negotiate) priceVerdict = 'NEGOTIATE HARD';
    else priceVerdict = 'MOVE ON';
  }

  const verdict =
    overall >= 8.5
      ? 'STRONG BUY'
      : overall >= 8.0
        ? 'SHORTLIST'
        : overall >= 7.0
          ? 'WORTH CONSIDERING'
          : overall >= 6.0
            ? 'ONLY AT A DISCOUNT'
            : overall >= 4.5
              ? 'WEAK'
              : 'PASS';

  return {
    district: district
      ? {
          key: district.key,
          name: district.name,
          flag: district.flag,
          note: district.note,
          salePerM2: district.salePerM2,
          rentPerM2: district.rentPerM2,
        }
      : null,
    microLocation: micro.applied,
    dims,
    overall,
    verdict,
    risks,
    notes,
    economics: {
      pricePerM2,
      benchmarkPerM2,
      discountPct:
        discountPct === null ? null : Math.round(discountPct * 10000) / 100,
      marketRent,
      realisticRent,
      rentAdjustments: adjustments,
      grossYield:
        grossYield === null ? null : Math.round(grossYield * 10000) / 100,
      yieldOnAllIn:
        yieldOnAllIn === null ? null : Math.round(yieldOnAllIn * 10000) / 100,
      costItems: costs.items,
      acquisitionCosts: costs.total,
      allInCost,
      fairPrice: fairPrice ? Math.round(fairPrice) : null,
      qualityFactor: Math.round(q * 100) / 100,
      qualityNotes: qNotes,
      bands,
      priceVerdict,
    },
    checklist: buildChecklist(listing, district),
  };
}

function buildChecklist(listing: Listing, district: any): string[] {
  const items = [
    'ITE (building inspection) status, and any pending façade or roof works',
    'Community accounts: debts, derramas voted or planned, monthly fee',
    'Cadastral surface and escritura vs the advertised m²',
  ];
  if (listing.elevator === false)
    items.push(
      'Whether an elevator is technically possible, and what the community would charge you'
    );
  if (listing.heating === false)
    items.push(
      'Which heating is installable (natural gas / electric / heat pump) and at what cost'
    );
  if (listing.flags?.rentaAntigua)
    items.push(
      'Rental contract, original date, current rent, tenant age, prior subrogations, 12 months of receipts'
    );
  if (listing.flags?.auction)
    items.push(
      'Outstanding debt, occupants, possession, the legal procedure and the realistic final adjudication price'
    );
  if (listing.flags?.aiEditedPhotos)
    items.push(
      'Visit in person: kitchen, bathroom, windows, electrical panel, pipes, walls, actual light'
    );
  if (district?.flag !== 'green')
    items.push(
      'Walk the exact street after dark: entrance, lighting, surrounding blocks, noise'
    );
  if (listing.garagePrice)
    items.push(
      `Whether the seller will sell without the €${listing.garagePrice.toLocaleString('es-ES')} garage`
    );
  items.push(
    'Achievable rent for this exact unit, from a local agent rather than portal averages'
  );
  return items;
}
