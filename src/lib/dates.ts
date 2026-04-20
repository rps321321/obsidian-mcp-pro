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
//   Q     quarter (1-4)          1
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

function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const now = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((now - start) / 86_400_000);
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
      MMMM: MONTHS[M - 1],
      MMM: MONTHS[M - 1].slice(0, 3),
      MM: pad2(M),
      Mo: ordinal(M),
      M: String(M),
      DDDD: pad3(dayOfYear(date)),
      DDD: String(dayOfYear(date)),
      DD: pad2(D),
      Do: ordinal(D),
      D: String(D),
      dddd: WEEKDAYS[d],
      ddd: WEEKDAYS[d].slice(0, 3),
      dd: WEEKDAYS[d].slice(0, 2),
      HH: pad2(H),
      H: String(H),
      hh: pad2(((H + 11) % 12) + 1),
      h: String(((H + 11) % 12) + 1),
      mm: pad2(m),
      m: String(m),
      ss: pad2(s),
      s: String(s),
      Q: String(Q),
    });

    if (match) {
      out.push(match.value);
      i += match.length;
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join("");
}

function matchToken(
  input: string,
  tokens: Record<string, string>,
): { value: string; length: number } | null {
  // Sort by descending length so multi-char tokens win over single chars.
  const keys = Object.keys(tokens).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (input.startsWith(key)) {
      return { value: tokens[key], length: key.length };
    }
  }
  return null;
}
