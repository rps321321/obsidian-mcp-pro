// Minimal moment.js-style date formatter covering the tokens Obsidian uses
// in daily-notes.json `format`. Avoids adding a moment/date-fns dependency
// for what is ultimately a small, well-bounded token substitution.
//
// Supported tokens (matching moment.js semantics):
//   YYYY  four-digit year        2026
//   YY    two-digit year         26
//   MMMM  month name             January
//   MMM   short month name       Jan
//   MM    zero-padded month      01
//   M     month number           1
//   DDDD  zero-padded day-of-yr  045
//   DDD   day of year            45
//   DD    zero-padded date       07
//   Do    ordinal date           7th
//   D     date                   7
//   dddd  weekday name           Monday
//   ddd   short weekday name     Mon
//   dd    two-letter weekday     Mo
//   HH/H  zero-padded / hour     (24h) 09 / 9
//   hh/h  zero-padded / hour     (12h) 09 / 9
//   mm/m  zero-padded / minute   05 / 5
//   ss/s  zero-padded / second   05 / 5
//   A/a   AM-PM / am-pm          PM / pm
//   Q     quarter (1-4)          1
//   WW/W  ISO week, padded/raw   19 / 19
//   ww    week of year (locale)  19
//   gggg  ISO week-year (4)      2026
//   gg    ISO week-year (2)      26
//   E     ISO weekday (1-7)      4   (Mon=1 .. Sun=7)
//   e     local weekday (0-6)    4   (Sun=0 .. Sat=6, matches Date#getDay)
//   X     unix timestamp (s)     1715385600
//   x     unix timestamp (ms)    1715385600000
//   [..]  literal text           [Q] → Q
//
// Unsupported tokens are left as-is. Callers that need locale variants
// should use the vault's actual runtime (Obsidian plugin) instead of this
// server-side fallback.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

// Cumulative day-count BEFORE each month in a non-leap year.
// MONTHS_NON_LEAP[0] = 0 (Jan starts at day 1, so 0 + day = day-of-year),
// MONTHS_NON_LEAP[1] = 31 (Feb 1 = day 32), etc.
const MONTHS_NON_LEAP = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad3(n: number): string {
  if (n < 10) return `00${n}`;
  if (n < 100) return `0${n}`;
  return String(n);
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// Direct table-based formula — bulletproof across DST transitions because it
// does no millisecond arithmetic, only integer month/day math on local fields.
// H4 fix: use local-time getters so DDDD aligns with the same local date the
// rest of the formatter uses (YYYY-MM-DD etc.). Mixing UTC and local fields
// near midnight in offset timezones (e.g. UTC+5:30) produced filenames whose
// day-of-year disagreed with their YYYY-MM-DD.
function dayOfYear(date: Date): number {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  return MONTHS_NON_LEAP[month]! + day + (isLeapYear(year) && month >= 2 ? 1 : 0);
}

// ISO 8601 week and week-year. Returns the week number (1-53) and the
// ISO week-numbering year, which can differ from the calendar year at
// year boundaries (e.g. 2027-01-01 may belong to ISO week 53 of 2026).
function isoWeek(date: Date): { week: number; year: number } {
  // Use UTC arithmetic to sidestep DST hour shifts inside the ms math.
  // The input is normalized to the start of the LOCAL calendar day, so the
  // ISO week reflects what the user sees on their wall calendar.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // Sun → 7, Mon → 1 ... Sat → 6
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday in current ISO week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { week: weekNum, year: d.getUTCFullYear() };
}

/**
 * Format a Date using a moment-style format string. Uses LOCAL time (which
 * matches Obsidian's own rendering — users expect `YYYY-MM-DD` to be their
 * local calendar date, not UTC).
 */
export function formatMomentDate(date: Date, format: string): string {
  const out: string[] = [];
  let i = 0;
  const Y = date.getFullYear();
  const M = date.getMonth() + 1;
  const D = date.getDate();
  const d = date.getDay();
  const H = date.getHours();
  const m = date.getMinutes();
  const s = date.getSeconds();
  const Q = Math.floor((M - 1) / 3) + 1;
  const { week: isoWeekNum, year: isoWeekYear } = isoWeek(date);
  const isoDay = d === 0 ? 7 : d; // ISO weekday: Mon=1 .. Sun=7
  const ampmUpper = H < 12 ? "AM" : "PM";
  const ampmLower = H < 12 ? "am" : "pm";
  const unixMs = date.getTime();
  const unixSec = Math.floor(unixMs / 1000);

  while (i < format.length) {
    const ch = format[i];

    // Bracketed literal — everything inside `[...]` is emitted verbatim.
    if (ch === "[") {
      const end = format.indexOf("]", i + 1);
      if (end === -1) { out.push(format.slice(i)); break; }
      out.push(format.slice(i + 1, end));
      i = end + 1;
      continue;
    }

    // Try longest-first so YYYY matches before YY, MMMM before MMM, etc.
    const rest = format.slice(i);
    const match = matchToken(rest, {
      YYYY: String(Y),
      YY: String(Y).slice(-2),
      MMMM: MONTHS[M - 1]!,
      MMM: MONTHS[M - 1]!.slice(0, 3),
      MM: pad2(M),
      Mo: ordinal(M),
      M: String(M),
      DDDD: pad3(dayOfYear(date)),
      DDD: String(dayOfYear(date)),
      DD: pad2(D),
      Do: ordinal(D),
      D: String(D),
      dddd: WEEKDAYS[d]!,
      ddd: WEEKDAYS[d]!.slice(0, 3),
      dd: WEEKDAYS[d]!.slice(0, 2),
      HH: pad2(H),
      H: String(H),
      hh: pad2(((H + 11) % 12) + 1),
      h: String(((H + 11) % 12) + 1),
      mm: pad2(m),
      m: String(m),
      ss: pad2(s),
      s: String(s),
      A: ampmUpper,
      a: ampmLower,
      Q: String(Q),
      WW: pad2(isoWeekNum),
      W: String(isoWeekNum),
      // No locale data on the server — `ww` mirrors ISO week (same as W/WW)
      // which is the most defensible default in absence of a locale.
      ww: pad2(isoWeekNum),
      gggg: String(isoWeekYear),
      gg: String(isoWeekYear).slice(-2),
      E: String(isoDay),
      e: String(d),
      X: String(unixSec),
      x: String(unixMs),
    });

    if (match) {
      out.push(match.value);
      i += match.length;
      continue;
    }

    out.push(ch!);
    i++;
  }

  return out.join("");
}

export function formatLocalDateOnly(date = new Date()): string {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join("-");
}

export function parseLocalDateOnly(input: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function matchToken(
  input: string,
  tokens: Record<string, string>,
): { value: string; length: number } | null {
  // Sort by descending length so multi-char tokens win over single chars.
  const keys = Object.keys(tokens).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (input.startsWith(key)) {
      return { value: tokens[key]!, length: key.length };
    }
  }
  return null;
}
