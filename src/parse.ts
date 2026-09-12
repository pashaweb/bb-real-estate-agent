// Parses the visible text of an Idealista listing page into structured fields.
// Text-based rather than selector-based: Idealista reshuffles its DOM often, but
// the Spanish wording of the feature list is stable.

const num = (s: unknown): number | null => {
  if (s == null) return null;
  const cleaned = String(s)
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/[^\d.]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
};

const has = (text: string, ...needles: string[]): boolean => needles.some((n) => text.includes(n));

const first = (text: string, ...regexes: RegExp[]): RegExpMatchArray | null => {
  for (const re of regexes) {
    const m = text.match(re);
    if (m) return m;
  }
  return null;
};

import type { Listing } from './types.js';

export interface StructuredFields {
  title?: string | null;
  subtitle?: string | null;
  price?: string | null;
  features?: string[];
  description?: string | null;
}

export interface ParseContext {
  url?: string;
  title?: string;
  structured?: StructuredFields | null;
}

export function parseListing(rawText: string, ctx: ParseContext = {}): Listing {
  const { url = '', title = '', structured = null } = ctx;
  const text = rawText.replace(/ /g, ' ').replace(/[ \t]+/g, ' ');
  const lower = text.toLowerCase();
  // Built dynamically, then returned through the Listing boundary below.
  const out: any = { url, sourceTitle: title, warnings: [] };

  // --- identity -------------------------------------------------------------
  const idm = url.match(/inmueble\/(\d+)/);
  out.externalId = idm ? idm[1] : null;

  const titleLine = first(
    text,
    /^\s*((?:Piso|Ático|Atico|Dúplex|Duplex|Estudio|Apartamento|Casa o chalet[^\n]*?|Chalet[^\n]*?|Loft)\s+en\s+[^\n]{3,120})$/im
  );
  out.title = (titleLine ? titleLine[1] : title || '')
    .trim()
    .replace(/\s+/g, ' ');

  const propType = first(
    lower,
    /\b(piso|ático|atico|dúplex|duplex|estudio|apartamento|casa o chalet|chalet|loft)\b/
  );
  out.propertyType = propType ? propType[1] : null;

  // "Milán-Pumarín-Teatinos, Oviedo" / "Ciudad Naranco-Prados de la Fuente, Oviedo".
  // The subtitle element is cleanest when present; in rendered innerText the
  // subtitle runs inline with the price, so the fallback must not anchor to $.
  const subtitle = structured?.subtitle?.trim();
  const loc = first(
    text,
    /^[ \t]*([A-ZÁÉÍÓÚÑ][^\n,]{2,60}),[ \t]*(?:Oviedo|Asturias)\b/m,
    /en\s+([^\n,]{3,60}),\s*Oviedo/
  );
  out.neighbourhood = subtitle
    ? subtitle.replace(/,\s*(?:Oviedo|Asturias)\s*$/i, '').trim()
    : loc
      ? loc[1].trim()
      : null;
  out.city = /(?:^|[\s,])oviedo\b/i.test(text)
    ? 'Oviedo'
    : (first(text, /,\s*([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\s*$/m)?.[1] ?? null);

  // --- price ----------------------------------------------------------------
  const priceM = first(
    text,
    /([\d.]{4,12})\s*€(?!\s*\/)/,
    /precio[^\d]{0,20}([\d.]{4,12})\s*€/i
  );
  out.price = num(structured?.price) ?? (priceM ? num(priceM[1]) : null);
  if (!out.price) out.warnings.push('price not found');

  const prevPriceM = first(
    text,
    /([\d.]{4,12})\s*€\s*\n?\s*([\d.]{4,12})\s*€\s*(\d{1,2})\s*%/
  );
  if (prevPriceM) {
    out.previousPrice = num(prevPriceM[2]);
    out.priceDropPct = num(prevPriceM[3]);
  }

  const perM2 = first(text, /([\d.]{3,9})\s*€\s*\/\s*m²/);
  out.advertisedPricePerM2 = perM2 ? num(perM2[1]) : null;

  // --- size / rooms ---------------------------------------------------------
  const built = first(
    text,
    /([\d.,]{1,7})\s*m²\s*construidos?/i,
    /([\d.,]{1,7})\s*m²(?!\s*(?:útiles|utiles|\/))/i
  );
  out.builtM2 = built ? num(built[1]) : null;
  const useful = first(text, /([\d.,]{1,7})\s*m²\s*(?:útiles|utiles)/i);
  out.usefulM2 = useful ? num(useful[1]) : null;
  if (!out.builtM2) out.warnings.push('size not found');

  const beds = first(text, /(\d{1,2})\s*(?:habitaciones?|hab\.|dormitorios?)/i);
  out.bedrooms = beds ? num(beds[1]) : has(lower, 'estudio') ? 0 : null;
  const baths = first(text, /(\d{1,2})\s*(?:baños?|aseos?)/i);
  out.bathrooms = baths ? num(baths[1]) : null;

  const plot = first(text, /parcela\s*(?:de)?\s*([\d.,]{1,7})\s*m²/i);
  out.plotM2 = plot ? num(plot[1]) : null;

  // --- floor / orientation --------------------------------------------------
  const floorM = first(
    text,
    /planta\s*(\d{1,2})\s*[ªa]/i,
    /\b(\d{1,2})\s*[ªa]\s*planta/i,
    /planta\s*(baja|entreplanta|bajo|sótano|semisótano)/i
  );
  if (floorM) {
    const v = floorM[1].toLowerCase();
    out.floor = /^\d+$/.test(v) ? Number(v) : v.startsWith('s') ? -1 : 0;
  } else out.floor = null;

  out.exterior = has(lower, 'exterior')
    ? true
    : has(lower, 'interior')
      ? false
      : null;

  // --- building features ----------------------------------------------------
  out.elevator = has(lower, 'sin ascensor')
    ? false
    : has(lower, 'con ascensor', 'ascensor')
      ? true
      : null;
  if (out.elevator === null) out.warnings.push('elevator unknown');

  // Read the fuel from a small vocabulary near the word: a greedy tail capture
  // swallows the rest of the sentence ("..., gastos de comunidad/mes de").
  const HEAT_FUELS = [
    ['gas natural', 'Gas natural'],
    ['eléctric', 'Eléctrica'],
    ['electric', 'Eléctrica'],
    ['gasóleo', 'Gasóleo'],
    ['gasoil', 'Gasóleo'],
    ['bomba de calor', 'Bomba de calor'],
    ['suelo radiante', 'Suelo radiante'],
    ['butano', 'Butano'],
    ['propano', 'Propano'],
    ['biomasa', 'Biomasa'],
    ['pellet', 'Pellets']
  ];
  const heatCtx = first(text, /calefacci[óo]n[^\n]{0,70}/i);
  if (has(lower, 'sin calefacción', 'no cuenta con calefacción', 'sin calefaccion')) {
    out.heating = false;
    out.heatingType = null;
  } else if (heatCtx) {
    const ctx = heatCtx[0].toLowerCase();
    const kind = /individual/.test(ctx) ? 'Individual' : /central/.test(ctx) ? 'Central' : null;
    const fuel = HEAT_FUELS.find(([k]) => ctx.includes(k))?.[1] ?? null;
    out.heating = true;
    out.heatingType = [kind, fuel].filter(Boolean).join(': ') || null;
  } else {
    out.heating = null;
    out.heatingType = null;
    out.warnings.push('heating unknown');
  }

  const yearM = first(
    text,
    /construido\s*en\s*(\d{4})/i,
    /año\s*de?\s*construcci[óo]n\s*:?\s*(\d{4})/i
  );
  out.yearBuilt = yearM ? Number(yearM[1]) : null;

  out.terrace = has(lower, 'terraza');
  out.storage = has(lower, 'trastero');
  out.balcony = has(lower, 'balcón', 'balcon');
  out.pool = has(lower, 'piscina');
  out.furnished = has(lower, 'amueblado');

  const garageExtra = first(
    text,
    /garaje\s*por\s*([\d.]{3,9})\s*€/i,
    /plaza de garaje[^\n]{0,40}?([\d.]{4,9})\s*€/i
  );
  out.garage = has(lower, 'garaje', 'plaza de garaje');
  out.garageIncluded = has(lower, 'garaje incluido en el precio');
  out.garagePrice = garageExtra ? num(garageExtra[1]) : null;

  const commM = first(
    text,
    /(?:gastos de )?comunidad\s*:?\s*([\d.,]{1,7})\s*€/i
  );
  out.communityFee = commM ? num(commM[1]) : null;

  // --- condition ------------------------------------------------------------
  if (has(lower, 'para reformar', 'a reformar', 'necesita reforma'))
    out.condition = 'needs-renovation';
  else if (has(lower, 'obra nueva')) out.condition = 'new-build';
  else if (has(lower, 'buen estado', 'reformado', 'rehabilitado'))
    out.condition = 'good';
  else out.condition = null;
  out.rehabilitatedBuilding = has(
    lower,
    'edificio rehabilitado',
    'rehabilitado'
  );

  // --- free text ------------------------------------------------------------
  const desc = first(text, /\n([^\n]{200,})\n/);
  out.description =
    structured?.description?.trim().slice(0, 2000) ||
    (desc ? desc[1].trim().slice(0, 2000) : null);

  // --- risk flags -----------------------------------------------------------
  // Scan the listing's own copy only. Idealista's footer advertises "Seguro Anti
  // Okupas" and "Certificado de inquilino no moroso" on every page, which makes a
  // whole-page scan report a sitting tenant on any property.
  const content = [
    structured?.title,
    structured?.subtitle,
    (structured?.features ?? []).join('\n'),
    structured?.description,
    out.title,
    out.description
  ]
    .filter(Boolean)
    .join('\n');
  const c = (content.length > 120 ? content : text).toLowerCase();
  const hasIn = (hay: string, ...needles: string[]): boolean => needles.some((n) => hay.includes(n));

  out.flags = {
    rentaAntigua: hasIn(c, 'renta antigua'),
    auction: hasIn(c, 'subasta', 'cesión de remate', 'cesion de remate'),
    occupied:
      /ocupad[oa]\s+por\s+(?:un\s+)?inquilin/.test(c) ||
      /(?:vende|vendido|venta)[^.]{0,40}con\s+inquilin/.test(c) ||
      /inquilino\s+en\s+vigor/.test(c) ||
      /actualmente\s+(?:ocupad|alquilad)[oa]/.test(c) ||
      /\bokupad[oa]/.test(c),
    noVisit: hasIn(c, 'no se puede visitar', 'no visitable'),
    notMortgageable: hasIn(c, 'no se puede hipotecar', 'no hipotecable'),
    buyerAgencyFee: hasIn(c, 'honorarios', 'comisión de agencia', '5% + iva'),
    // A photo annotation, so it lives in the gallery rather than the description.
    aiEditedPhotos: has(lower, 'foto editada con ia', 'editada con ia'),
    priceOnRequest: hasIn(c, 'consultar precio')
  };

  const feeM = first(
    content.length > 120 ? content : text,
    /(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:\+\s*iva)?[^\n]{0,40}(?:honorarios|agencia|comprador)/i,
    /honorarios[^\n]{0,40}?(\d{1,2}(?:[.,]\d+)?)\s*%/i
  );
  out.buyerFeePct = feeM ? num(feeM[1]) : null;

  if (out.builtM2 && out.price)
    out.pricePerM2 = Math.round(out.price / out.builtM2);
  else out.pricePerM2 = out.advertisedPricePerM2;

  return out as unknown as Listing;
}

export const _test = { num };
