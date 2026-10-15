/**
 * Deskzo's preset of abusive words (owner, 15 Oct 2026): English, Hindi in Devanagari, and Hindi typed
 * in Roman letters (Hinglish), the way people actually type them. A workspace switches it on or off per
 * area and can let any of its words through (a name that happens to be one, say); its own words are
 * added beside it. How an entry matches — whole words, disguises, a trailing * for endings — is
 * src/lib/word-filter/match.ts.
 *
 * Deliberately left out: words that are mostly something else in a workplace, where blocking them would
 * refuse ordinary messages — "dick" and "kamini" (names), "chink" (in the armour), "bc"/"mc" (before
 * Christ, master of ceremonies), "chod" (people type "chod do" for "leave it"), "kutta" (a dog), "hoe" (a
 * garden tool), "laude" (cum laude), "lode", "bloody", "damn", "hell", "crap". A workspace that wants
 * them adds them itself.
 *
 * A trailing * only where nothing ordinary starts the same way: "shit*" would catch shiitake, "retard*"
 * fire retardant, "nigga*" niggardly and "randi*" the name Randip — those list their endings instead.
 */

export const PRESET_ENGLISH: readonly string[] = [
  "fuck*", "motherfuck*", "fuk", "fukk*", "fck", "fcuk*", "phuck*", "stfu",
  "shit", "shits", "shitty", "shitting", "shithead*", "shitshow", "bullshit*", "horseshit",
  "bitch*", "sonofabitch", "son of a bitch",
  "bastard*", "asshole*", "arsehole*", "ass", "arse", "dumbass*", "jackass*", "smartass*",
  "dickhead*", "cunt*", "twat*", "wanker*",
  "slut*", "whore*", "skank*",
  "pussy", "cock", "cocksuck*", "blowjob*", "jerkoff", "jerk off",
  "bollocks", "piss off", "pissoff",
  "retard", "retards", "retarded", "nigger", "niggers", "nigga", "niggas", "faggot*",
];

export const PRESET_HINDI: readonly string[] = [
  "चूतिया", "चुतिया", "चूतिये", "चुतिये", "चूतियापा", "चूत", "चुत",
  "भेनचोद", "बहनचोद", "बहिनचोद", "भैनचोद", "बेहेनचोद",
  "मादरचोद", "मादरचोत",
  "भोसड़ी", "भोसड़ीके", "भोसड़ीवाले", "भोसड़ा", "भोसड़े",
  "गांड", "गाँड", "गांडू", "गाँडू", "गांडु",
  "लौड़ा", "लौड़े", "लोड़ू", "लंड", "लण्ड",
  "रंडी", "रण्डी", "रंडवा",
  "हरामी", "हरामखोर", "हरामज़ादा", "हरामज़ादे", "हरामज़ादी",
  "कुतिया", "कमीना", "कमीने", "कमीनी",
  "झांट", "झाँट", "झांटू", "झाँटू",
  "भड़वा", "भड़वे", "भड़वी",
  "चोदू", "चुदाई", "चोदना",
];

export const PRESET_HINGLISH: readonly string[] = [
  "chutiya*", "chutia*", "chootiya*", "chutiye", "chootiye", "chut", "choot",
  "bhenchod*", "behenchod*", "bahenchod*", "bhanchod*", "benchod*", "behnchod*", "bhencho", "behencho",
  "madarchod*", "maderchod*", "madharchod*", "maadarchod*", "madarjaat",
  "bhosdike", "bhosadike", "bhosdika", "bhosdiwala", "bhosdiwale", "bhosda", "bhosde", "bhosdi", "bhosadi", "bhosri", "bsdk",
  "gaand*", "gand", "gandu", "gaandu",
  "lund", "lauda", "laude ke", "lawda", "lavda", "lavde", "lawde", "lodu", "loda",
  "randi", "randiya", "randiyon", "randwa", "randibaaz*",
  "harami", "haramkhor", "haramzada", "haramzade", "haramzadi", "haraamzaada",
  "kutiya", "kutte ki aulaad", "kamina", "kameena", "kamine", "kaminey",
  "jhaant*", "jhant", "jhantu", "jhaatu", "jhatu",
  "bhadwa", "bhadwe", "bhadve", "bhadva", "bhadwi",
  "chodu", "chudai", "chudakkad*",
  "bakchod*", "mkc", "bkl", "tmkc",
];

/** The whole preset, as one list. */
export const PRESET_WORDS: readonly string[] = [...PRESET_ENGLISH, ...PRESET_HINDI, ...PRESET_HINGLISH];
