// Shapes shared by the parser, the scorer and the prompt builder.

export interface ListingFlags {
  rentaAntigua?: boolean;
  auction?: boolean;
  occupied?: boolean;
  noVisit?: boolean;
  notMortgageable?: boolean;
  buyerAgencyFee?: boolean;
  aiEditedPhotos?: boolean;
  priceOnRequest?: boolean;
}

export interface Listing {
  url: string;
  sourceTitle?: string;
  warnings: string[];
  externalId: string | null;
  title: string;
  propertyType: string | null;
  neighbourhood: string | null;
  city: string | null;
  price: number | null;
  previousPrice?: number | null;
  priceDropPct?: number | null;
  advertisedPricePerM2: number | null;
  pricePerM2: number | null;
  builtM2: number | null;
  usefulM2: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  plotM2: number | null;
  floor: number | null;
  exterior: boolean | null;
  elevator: boolean | null;
  heating: boolean | null;
  heatingType: string | null;
  yearBuilt: number | null;
  terrace: boolean;
  storage: boolean;
  balcony: boolean;
  pool: boolean;
  furnished: boolean;
  garage: boolean;
  garageIncluded: boolean;
  garagePrice: number | null;
  communityFee: number | null;
  condition: 'good' | 'needs-renovation' | 'new-build' | null;
  rehabilitatedBuilding: boolean;
  buyerFeePct: number | null;
  description: string | null;
  flags: ListingFlags;
}

export interface DistrictRef {
  key: string;
  name: string;
  flag: string;
  note: string;
  salePerM2: number;
  rentPerM2: number;
  estimated?: boolean;
}

export interface CostItem {
  label: string;
  amount: number;
}

export interface Economics {
  pricePerM2: number | null;
  benchmarkPerM2: number | null;
  discountPct: number | null;
  marketRent: number | null;
  realisticRent: number | null;
  rentAdjustments: string[];
  grossYield: number | null;
  yieldOnAllIn: number | null;
  costItems: CostItem[];
  acquisitionCosts: number;
  allInCost: number | null;
  fairPrice: number | null;
  qualityFactor: number;
  qualityNotes: string[];
  bands: {
    excellent: number;
    veryGood: number;
    good: number;
    negotiate: number;
  } | null;
  priceVerdict: string | null;
}

export interface Risk {
  label: string;
  penalty: number;
  why: string;
}

export interface Score {
  district: DistrictRef | null;
  microLocation: string[];
  dims: Record<string, number | null>;
  overall: number;
  verdict: string;
  risks: Risk[];
  notes: string[];
  economics: Economics;
  checklist: string[];
}

/** A model offered by one of BB's configured providers. */
export interface ModelOption {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  routeProviderId?: string;
  /** Which provider offers it — model ids are only unique within a provider. */
  providerId: string;
  providerName: string;
}

/** What the chosen model said about a listing. */
export interface ModelVerdict {
  modelId: string;
  providerId: string;
  score: number | null;
  text: string;
  threadId: string;
  at: string;
}
