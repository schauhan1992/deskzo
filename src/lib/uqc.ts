import { kindOfCode } from "@/lib/hsn";
import { normaliseHsn } from "@/lib/items/catalogue-import";

/**
 * Unit Quantity Codes: the GST portal's fixed list of units, which GSTR-1's HSN summary (Table 12)
 * reports quantities in. An item's unit is typed freely — "Piece", "Box", "Seat / year" — so this is
 * the one place that reads a typed unit as a portal code.
 *
 * Services are reported with "NA" and no quantity: a SAC line has no unit the portal counts (OTH is
 * not accepted for them). Goods whose unit names none of these go as OTH, which the portal accepts but
 * an accountant may want to correct on the item.
 */
export const UQC_CODES = {
  BAG: "Bags",
  BAL: "Bale",
  BDL: "Bundles",
  BKL: "Buckles",
  BOU: "Billion of units",
  BOX: "Box",
  BTL: "Bottles",
  BUN: "Bunches",
  CAN: "Cans",
  CBM: "Cubic metres",
  CCM: "Cubic centimetres",
  CMS: "Centimetres",
  CTN: "Cartons",
  DOZ: "Dozens",
  DRM: "Drums",
  GGR: "Great gross",
  GMS: "Grammes",
  GRS: "Gross",
  GYD: "Gross yards",
  KGS: "Kilograms",
  KLR: "Kilolitre",
  KME: "Kilometre",
  LTR: "Litres",
  MLT: "Millilitre",
  MTR: "Metres",
  MTS: "Metric ton",
  NOS: "Numbers",
  PAC: "Packs",
  PCS: "Pieces",
  PRS: "Pairs",
  QTL: "Quintal",
  ROL: "Rolls",
  SET: "Sets",
  SQF: "Square feet",
  SQM: "Square metres",
  SQY: "Square yards",
  TBS: "Tablets",
  TGM: "Ten gross",
  THD: "Thousands",
  TON: "Tonnes",
  TUB: "Tubes",
  UGS: "US gallons",
  UNT: "Units",
  YDS: "Yards",
  OTH: "Others",
} as const;

export type UqcCode = keyof typeof UQC_CODES;
/** What a line is reported under: a unit code for goods, NA for a service. */
export type LineUqc = UqcCode | "NA";

/** Units as people type them, singular and lower-case, against the code each one means. */
const SPELLINGS: Record<string, UqcCode> = {
  piece: "PCS",
  pc: "PCS",
  no: "NOS",
  number: "NOS",
  each: "NOS",
  ea: "NOS",
  unit: "UNT",
  set: "SET",
  box: "BOX",
  pack: "PAC",
  packet: "PAC",
  pkt: "PAC",
  pair: "PRS",
  dozen: "DOZ",
  dz: "DOZ",
  kg: "KGS",
  kilo: "KGS",
  kilogram: "KGS",
  kilogramme: "KGS",
  g: "GMS",
  gm: "GMS",
  gram: "GMS",
  gramme: "GMS",
  l: "LTR",
  lt: "LTR",
  litre: "LTR",
  liter: "LTR",
  ml: "MLT",
  millilitre: "MLT",
  milliliter: "MLT",
  kl: "KLR",
  kilolitre: "KLR",
  kiloliter: "KLR",
  m: "MTR",
  meter: "MTR",
  metre: "MTR",
  cm: "CMS",
  centimeter: "CMS",
  centimetre: "CMS",
  km: "KME",
  kilometer: "KME",
  kilometre: "KME",
  sqft: "SQF",
  "sq ft": "SQF",
  "square foot": "SQF",
  "square feet": "SQF",
  sqm: "SQM",
  "sq m": "SQM",
  "sq mtr": "SQM",
  "square meter": "SQM",
  "square metre": "SQM",
  "sq yd": "SQY",
  "square yard": "SQY",
  yard: "YDS",
  yd: "YDS",
  roll: "ROL",
  bottle: "BTL",
  bag: "BAG",
  bale: "BAL",
  bundle: "BDL",
  bunch: "BUN",
  carton: "CTN",
  can: "CAN",
  drum: "DRM",
  tube: "TUB",
  tablet: "TBS",
  thousand: "THD",
  quintal: "QTL",
  ton: "TON",
  tonne: "TON",
  mt: "MTS",
  "metric ton": "MTS",
  "metric tonne": "MTS",
  cbm: "CBM",
  "cubic meter": "CBM",
  "cubic metre": "CBM",
  cc: "CCM",
  "cubic centimeter": "CCM",
  "cubic centimetre": "CCM",
};

/**
 * The portal code a unit as typed names, or null when it names none. "Piece", "pcs" and "PCS" are all
 * PCS; anything after a slash is the billing period, not the unit ("Pack / year" is a pack).
 */
export function uqcOfUnit(unit: string | null | undefined): UqcCode | null {
  const typed = String(unit ?? "")
    .split("/")[0]
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!typed) return null;
  const upper = typed.toUpperCase();
  if (upper in UQC_CODES) return upper as UqcCode;
  const word = typed.toLowerCase();
  return SPELLINGS[word] ?? SPELLINGS[word.replace(/s$/, "")] ?? SPELLINGS[word.replace(/es$/, "")] ?? null;
}

/**
 * The code a sales line is reported under: NA for a service — its code is a SAC, starting 99 — and for
 * goods the unit's own code, or OTH when the unit names none.
 */
export function uqcForLine(line: { hsnCode: string | null; unit: string | null }): LineUqc {
  const code = normaliseHsn(line.hsnCode);
  if (code && kindOfCode(code) === "SERVICES") return "NA";
  return uqcOfUnit(line.unit) ?? "OTH";
}
