import { GST_STATE_CODES, stateKey } from "@/lib/gst-engine";

/**
 * Where a customer is, chosen rather than typed.
 *
 * ## Why this is not a convenience
 *
 * `state` is not a label. `stateCodeFromName` turns it into a GST state code, and that code decides
 * whether a document carries CGST + SGST or IGST. A state the lookup cannot match yields no code at
 * all, and `isIntraState` then treats the supply as inter-state — so a Gurugram customer typed in as
 * "harayna" is silently charged IGST on a Haryana-to-Haryana sale. Nothing errors, nothing is
 * flagged, and the first anybody hears of it is a customer who cannot claim the credit.
 *
 * That exact row is in this database today. It was typed by hand, which is the only way it could
 * have got there.
 *
 * ## States are derived, never duplicated
 *
 * The list below is built from `GST_STATE_CODES` rather than written out again. Two lists of Indian
 * states that are supposed to agree is two lists that will not: the picker would offer a spelling
 * the tax engine does not recognise, which is the bug this is meant to remove, reintroduced one
 * layer up.
 */

export type StateOption = { code: string; name: string };

/** Every state and union territory, in GST code order — which is also how the portal lists them. */
export const INDIAN_STATES: StateOption[] = Object.entries(GST_STATE_CODES)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Cities worth suggesting, by state.
 *
 * Deliberately a suggestion list and not a closed one. India has thousands of towns and a B2B
 * customer is as likely to be in Hosur or Bhiwadi as in Mumbai; a dropdown that could not express
 * where somebody actually is would be worse than the free text it replaced, because it would push
 * people to pick the nearest wrong answer. So the city field takes anything — these just save the
 * typing for the addresses that come up again and again, and keep the spelling consistent when
 * they do.
 *
 * The state above it is closed, because that one has to match the tax engine.
 */
export const CITIES_BY_STATE: Record<string, string[]> = {
  "Andaman & Nicobar Islands": ["Port Blair"],
  "Andhra Pradesh": ["Visakhapatnam", "Vijayawada", "Guntur", "Nellore", "Tirupati", "Kakinada", "Rajahmundry", "Kurnool"],
  "Arunachal Pradesh": ["Itanagar", "Naharlagun"],
  Assam: ["Guwahati", "Silchar", "Dibrugarh", "Jorhat", "Tezpur"],
  Bihar: ["Patna", "Gaya", "Muzaffarpur", "Bhagalpur", "Darbhanga"],
  Chandigarh: ["Chandigarh"],
  Chhattisgarh: ["Raipur", "Bhilai", "Bilaspur", "Korba", "Durg"],
  "Dadra & Nagar Haveli and Daman & Diu": ["Silvassa", "Daman", "Diu"],
  Delhi: ["New Delhi", "Delhi", "Dwarka", "Rohini", "Saket", "Okhla", "Nehru Place"],
  Goa: ["Panaji", "Margao", "Vasco da Gama", "Verna"],
  Gujarat: ["Ahmedabad", "Surat", "Vadodara", "Rajkot", "Gandhinagar", "Bhavnagar", "Jamnagar", "Anand", "Vapi", "Bharuch"],
  Haryana: ["Gurugram", "Faridabad", "Panipat", "Ambala", "Karnal", "Hisar", "Rohtak", "Sonipat", "Manesar", "Bahadurgarh"],
  "Himachal Pradesh": ["Shimla", "Baddi", "Solan", "Dharamshala", "Mandi"],
  "Jammu & Kashmir": ["Srinagar", "Jammu"],
  Jharkhand: ["Ranchi", "Jamshedpur", "Dhanbad", "Bokaro"],
  Karnataka: ["Bengaluru", "Mysuru", "Mangaluru", "Hubballi", "Belagavi", "Davangere", "Tumakuru", "Ballari"],
  Kerala: ["Kochi", "Thiruvananthapuram", "Kozhikode", "Thrissur", "Kollam", "Kannur", "Alappuzha"],
  Ladakh: ["Leh", "Kargil"],
  Lakshadweep: ["Kavaratti"],
  "Madhya Pradesh": ["Indore", "Bhopal", "Jabalpur", "Gwalior", "Ujjain", "Sagar", "Pithampur"],
  Maharashtra: ["Mumbai", "Pune", "Navi Mumbai", "Thane", "Nagpur", "Nashik", "Aurangabad", "Kolhapur", "Solapur", "Pimpri-Chinchwad", "Chakan", "Ahmednagar"],
  Manipur: ["Imphal"],
  Meghalaya: ["Shillong"],
  Mizoram: ["Aizawl"],
  Nagaland: ["Kohima", "Dimapur"],
  Odisha: ["Bhubaneswar", "Cuttack", "Rourkela", "Sambalpur", "Puri"],
  // Both are GST pseudo-states for supplies that fall outside any of them. No city list
  // applies; they exist so the picker can offer every code the portal accepts.
  "Other Country": [],
  "Other Territory": [],
  Puducherry: ["Puducherry", "Karaikal"],
  Punjab: ["Ludhiana", "Amritsar", "Jalandhar", "Mohali", "Patiala", "Bathinda"],
  Rajasthan: ["Jaipur", "Jodhpur", "Udaipur", "Kota", "Ajmer", "Bhiwadi", "Alwar", "Bikaner"],
  Sikkim: ["Gangtok"],
  "Tamil Nadu": ["Chennai", "Coimbatore", "Madurai", "Tiruchirappalli", "Salem", "Hosur", "Tirupur", "Erode", "Vellore", "Sriperumbudur"],
  Telangana: ["Hyderabad", "Secunderabad", "Warangal", "Nizamabad", "Karimnagar", "Medchal"],
  Tripura: ["Agartala"],
  "Uttar Pradesh": ["Noida", "Greater Noida", "Ghaziabad", "Lucknow", "Kanpur", "Agra", "Varanasi", "Meerut", "Prayagraj", "Moradabad"],
  Uttarakhand: ["Dehradun", "Haridwar", "Rudrapur", "Haldwani", "Pantnagar", "Roorkee"],
  "West Bengal": ["Kolkata", "Howrah", "Siliguri", "Durgapur", "Asansol", "Kharagpur"],
};

/** Suggestions for a state, or nothing where we hold none — the field still accepts anything. */
export function citiesIn(state: string | null | undefined): string[] {
  if (!state) return [];
  const exact = CITIES_BY_STATE[state];
  if (exact) return exact;
  // Matched the way the tax engine matches, so a state stored before the picker existed — or
  // written "Jammu and Kashmir" rather than with an ampersand — still gets its suggestions.
  const key = stateKey(state.trim());
  const found = Object.keys(CITIES_BY_STATE).find((s) => stateKey(s) === key);
  return found ? CITIES_BY_STATE[found]! : [];
}
