import { WORLD_COUNTRIES } from "@/lib/geo/world-countries";
import { ZONE_ALIASES, clockFor, isTimeZone } from "@/lib/time/zone";

/**
 * The zones a workspace or the console may choose from, and the one a new workspace starts in for its
 * country (src/lib/time/zone.ts for the clock itself). Pure.
 */

/** A zone under the name it goes by now — "Asia/Calcutta" is Asia/Kolkata. */
export function canonicalZone(zone: string): string {
  return ZONE_ALIASES[zone] ?? zone;
}

/** A zone a person may choose: one the runtime knows, under its current name. Null for anything else. */
export function readTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const zone = canonicalZone(value.trim());
  return isTimeZone(zone) ? zone : null;
}

export type ZoneOption = { zone: string; label: string; offsetMinutes: number };

function offsetMinutesOf(zone: string, now: Date): number {
  const label = clockFor(zone).offsetLabel(now);
  const match = /^UTC([+-])(\d{2}):(\d{2})$/.exec(label);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/** "UTC+05:30 · Asia/Kolkata" — the zone's offset now, then its name as a place. */
export function zoneLabel(zone: string, now = new Date()): string {
  if (zone === "UTC") return "UTC";
  return `${clockFor(zone).offsetLabel(now)} · ${zone.replace(/_/g, " ")}`;
}

/** The countries whose zone this is by default — so a picker finds Asia/Kolkata by typing "India". */
function countriesIn(zone: string): string[] {
  return WORLD_COUNTRIES.filter((c) => COUNTRY_ZONES[c.code] === zone).map((c) => c.name);
}

/**
 * Every zone the runtime knows, under current names, west to east, for a picker:
 * "Asia/Kolkata — India (UTC+05:30)", found by typing the place or the country.
 */
export function zoneOptions(now = new Date()): ZoneOption[] {
  const listed = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const zones = new Set<string>(["UTC"]);
  for (const zone of listed) {
    const current = canonicalZone(zone);
    if (isTimeZone(current)) zones.add(current);
  }
  return [...zones]
    .map((zone) => {
      if (zone === "UTC") return { zone, label: "UTC — Coordinated Universal Time", offsetMinutes: 0 };
      const countries = countriesIn(zone);
      const place = zone.replace(/_/g, " ");
      const label = `${place}${countries.length > 0 ? ` — ${countries.join(", ")}` : ""} (${clockFor(zone).offsetLabel(now)})`;
      return { zone, label, offsetMinutes: offsetMinutesOf(zone, now) };
    })
    .sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.zone.localeCompare(b.zone));
}

/**
 * The zone a new workspace starts in for its country: the capital's or the busiest city's where a
 * country spans several — it is the owner's to change in Settings. UTC where nobody lives.
 */
export const COUNTRY_ZONES: Readonly<Record<string, string>> = {
  IN: "Asia/Kolkata",
  AF: "Asia/Kabul",
  AX: "Europe/Mariehamn",
  AL: "Europe/Tirane",
  DZ: "Africa/Algiers",
  AS: "Pacific/Pago_Pago",
  AD: "Europe/Andorra",
  AO: "Africa/Luanda",
  AI: "America/Anguilla",
  AQ: "UTC",
  AG: "America/Antigua",
  AR: "America/Argentina/Buenos_Aires",
  AM: "Asia/Yerevan",
  AW: "America/Aruba",
  AU: "Australia/Sydney",
  AT: "Europe/Vienna",
  AZ: "Asia/Baku",
  BS: "America/Nassau",
  BH: "Asia/Bahrain",
  BD: "Asia/Dhaka",
  BB: "America/Barbados",
  BY: "Europe/Minsk",
  BE: "Europe/Brussels",
  BZ: "America/Belize",
  BJ: "Africa/Porto-Novo",
  BM: "Atlantic/Bermuda",
  BT: "Asia/Thimphu",
  BO: "America/La_Paz",
  BQ: "America/Kralendijk",
  BA: "Europe/Sarajevo",
  BW: "Africa/Gaborone",
  BV: "UTC",
  BR: "America/Sao_Paulo",
  IO: "Indian/Chagos",
  VG: "America/Tortola",
  BN: "Asia/Brunei",
  BG: "Europe/Sofia",
  BF: "Africa/Ouagadougou",
  BI: "Africa/Bujumbura",
  CV: "Atlantic/Cape_Verde",
  KH: "Asia/Phnom_Penh",
  CM: "Africa/Douala",
  CA: "America/Toronto",
  KY: "America/Cayman",
  CF: "Africa/Bangui",
  TD: "Africa/Ndjamena",
  CL: "America/Santiago",
  CN: "Asia/Shanghai",
  CX: "Indian/Christmas",
  CC: "Indian/Cocos",
  CO: "America/Bogota",
  KM: "Indian/Comoro",
  CK: "Pacific/Rarotonga",
  CR: "America/Costa_Rica",
  HR: "Europe/Zagreb",
  CU: "America/Havana",
  CW: "America/Curacao",
  CY: "Asia/Nicosia",
  CZ: "Europe/Prague",
  CD: "Africa/Kinshasa",
  DK: "Europe/Copenhagen",
  DJ: "Africa/Djibouti",
  DM: "America/Dominica",
  DO: "America/Santo_Domingo",
  EC: "America/Guayaquil",
  EG: "Africa/Cairo",
  SV: "America/El_Salvador",
  GQ: "Africa/Malabo",
  ER: "Africa/Asmara",
  EE: "Europe/Tallinn",
  SZ: "Africa/Mbabane",
  ET: "Africa/Addis_Ababa",
  FK: "Atlantic/Stanley",
  FO: "Atlantic/Faroe",
  FJ: "Pacific/Fiji",
  FI: "Europe/Helsinki",
  FR: "Europe/Paris",
  GF: "America/Cayenne",
  PF: "Pacific/Tahiti",
  TF: "Indian/Kerguelen",
  GA: "Africa/Libreville",
  GM: "Africa/Banjul",
  GE: "Asia/Tbilisi",
  DE: "Europe/Berlin",
  GH: "Africa/Accra",
  GI: "Europe/Gibraltar",
  GR: "Europe/Athens",
  GL: "America/Nuuk",
  GD: "America/Grenada",
  GP: "America/Guadeloupe",
  GU: "Pacific/Guam",
  GT: "America/Guatemala",
  GG: "Europe/Guernsey",
  GN: "Africa/Conakry",
  GW: "Africa/Bissau",
  GY: "America/Guyana",
  HT: "America/Port-au-Prince",
  HM: "UTC",
  HN: "America/Tegucigalpa",
  HK: "Asia/Hong_Kong",
  HU: "Europe/Budapest",
  IS: "Atlantic/Reykjavik",
  ID: "Asia/Jakarta",
  IR: "Asia/Tehran",
  IQ: "Asia/Baghdad",
  IE: "Europe/Dublin",
  IM: "Europe/Isle_of_Man",
  IL: "Asia/Jerusalem",
  IT: "Europe/Rome",
  CI: "Africa/Abidjan",
  JM: "America/Jamaica",
  JP: "Asia/Tokyo",
  JE: "Europe/Jersey",
  JO: "Asia/Amman",
  KZ: "Asia/Almaty",
  KE: "Africa/Nairobi",
  KI: "Pacific/Tarawa",
  KW: "Asia/Kuwait",
  KG: "Asia/Bishkek",
  LA: "Asia/Vientiane",
  LV: "Europe/Riga",
  LB: "Asia/Beirut",
  LS: "Africa/Maseru",
  LR: "Africa/Monrovia",
  LY: "Africa/Tripoli",
  LI: "Europe/Vaduz",
  LT: "Europe/Vilnius",
  LU: "Europe/Luxembourg",
  MO: "Asia/Macau",
  MG: "Indian/Antananarivo",
  MW: "Africa/Blantyre",
  MY: "Asia/Kuala_Lumpur",
  MV: "Indian/Maldives",
  ML: "Africa/Bamako",
  MT: "Europe/Malta",
  MH: "Pacific/Majuro",
  MQ: "America/Martinique",
  MR: "Africa/Nouakchott",
  MU: "Indian/Mauritius",
  YT: "Indian/Mayotte",
  MX: "America/Mexico_City",
  FM: "Pacific/Pohnpei",
  MD: "Europe/Chisinau",
  MC: "Europe/Monaco",
  MN: "Asia/Ulaanbaatar",
  ME: "Europe/Podgorica",
  MS: "America/Montserrat",
  MA: "Africa/Casablanca",
  MZ: "Africa/Maputo",
  MM: "Asia/Yangon",
  NA: "Africa/Windhoek",
  NR: "Pacific/Nauru",
  NP: "Asia/Kathmandu",
  NL: "Europe/Amsterdam",
  NC: "Pacific/Noumea",
  NZ: "Pacific/Auckland",
  NI: "America/Managua",
  NE: "Africa/Niamey",
  NG: "Africa/Lagos",
  NU: "Pacific/Niue",
  NF: "Pacific/Norfolk",
  KP: "Asia/Pyongyang",
  MK: "Europe/Skopje",
  MP: "Pacific/Saipan",
  NO: "Europe/Oslo",
  OM: "Asia/Muscat",
  PK: "Asia/Karachi",
  PW: "Pacific/Palau",
  PS: "Asia/Gaza",
  PA: "America/Panama",
  PG: "Pacific/Port_Moresby",
  PY: "America/Asuncion",
  PE: "America/Lima",
  PH: "Asia/Manila",
  PN: "Pacific/Pitcairn",
  PL: "Europe/Warsaw",
  PT: "Europe/Lisbon",
  PR: "America/Puerto_Rico",
  QA: "Asia/Qatar",
  CG: "Africa/Brazzaville",
  RE: "Indian/Reunion",
  RO: "Europe/Bucharest",
  RU: "Europe/Moscow",
  RW: "Africa/Kigali",
  BL: "America/St_Barthelemy",
  SH: "Atlantic/St_Helena",
  KN: "America/St_Kitts",
  LC: "America/St_Lucia",
  MF: "America/Marigot",
  PM: "America/Miquelon",
  VC: "America/St_Vincent",
  WS: "Pacific/Apia",
  SM: "Europe/San_Marino",
  ST: "Africa/Sao_Tome",
  SA: "Asia/Riyadh",
  SN: "Africa/Dakar",
  RS: "Europe/Belgrade",
  SC: "Indian/Mahe",
  SL: "Africa/Freetown",
  SG: "Asia/Singapore",
  SX: "America/Lower_Princes",
  SK: "Europe/Bratislava",
  SI: "Europe/Ljubljana",
  SB: "Pacific/Guadalcanal",
  SO: "Africa/Mogadishu",
  ZA: "Africa/Johannesburg",
  GS: "Atlantic/South_Georgia",
  KR: "Asia/Seoul",
  SS: "Africa/Juba",
  ES: "Europe/Madrid",
  LK: "Asia/Colombo",
  SD: "Africa/Khartoum",
  SR: "America/Paramaribo",
  SJ: "Arctic/Longyearbyen",
  SE: "Europe/Stockholm",
  CH: "Europe/Zurich",
  SY: "Asia/Damascus",
  TW: "Asia/Taipei",
  TJ: "Asia/Dushanbe",
  TZ: "Africa/Dar_es_Salaam",
  TH: "Asia/Bangkok",
  TL: "Asia/Dili",
  TG: "Africa/Lome",
  TK: "Pacific/Fakaofo",
  TO: "Pacific/Tongatapu",
  TT: "America/Port_of_Spain",
  TN: "Africa/Tunis",
  TR: "Europe/Istanbul",
  TM: "Asia/Ashgabat",
  TC: "America/Grand_Turk",
  TV: "Pacific/Funafuti",
  VI: "America/St_Thomas",
  UG: "Africa/Kampala",
  UA: "Europe/Kyiv",
  AE: "Asia/Dubai",
  GB: "Europe/London",
  US: "America/New_York",
  UM: "UTC",
  UY: "America/Montevideo",
  UZ: "Asia/Tashkent",
  VU: "Pacific/Efate",
  VA: "Europe/Vatican",
  VE: "America/Caracas",
  VN: "Asia/Ho_Chi_Minh",
  WF: "Pacific/Wallis",
  EH: "Africa/El_Aaiun",
  YE: "Asia/Aden",
  ZM: "Africa/Lusaka",
  ZW: "Africa/Harare",
};

/** The zone a workspace in this country starts in; UTC for a country the table doesn't know. */
export function defaultZoneFor(country: string | null | undefined): string {
  return COUNTRY_ZONES[(country ?? "").toUpperCase()] ?? "UTC";
}
