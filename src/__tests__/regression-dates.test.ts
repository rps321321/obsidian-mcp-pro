import { describe, it, expect } from "vitest";
import { formatMomentDate } from "../lib/dates.js";

// Regression coverage for two audit findings on the moment-style formatter
// in src/lib/dates.ts:
//
//   - H4: dayOfYear previously mixed UTC and local time. Near midnight in
//         non-UTC timezones, `DDDD` could report day 365 of last year while
//         `YYYY-MM-DD` reported the new year. Filenames composed from these
//         tokens disagreed with each other.
//   - O7: Several moment tokens commonly seen in Obsidian daily-note
//         templates were unsupported (A/a, W/WW/ww, gggg/gg, E/e, X/x).
//
// All assertions use local-constructed Dates so the test is timezone-stable.

describe("dayOfYear (H4)", () => {
  it("matches the local calendar date for Jan 1 even at midnight", () => {
    // The original UTC-mixed implementation could yield 365/366 here in a
    // positive-offset timezone (e.g. UTC+5:30 at 00:30 local on Jan 1, the
    // UTC date is still Dec 31 of the prior year).
    const d = new Date(2027, 0, 1, 0, 0, 0);
    expect(formatMomentDate(d, "DDDD")).toBe("001");
    expect(formatMomentDate(d, "DDD")).toBe("1");
    // The composed filename agrees with itself.
    expect(formatMomentDate(d, "YYYY-DDDD")).toBe("2027-001");
    expect(formatMomentDate(d, "YYYY-MM-DD")).toBe("2027-01-01");
  });

  it("handles leap day correctly (Feb 29 = day 060)", () => {
    const d = new Date(2024, 1, 29);
    expect(formatMomentDate(d, "DDDD")).toBe("060");
    expect(formatMomentDate(d, "DDD")).toBe("60");
  });

  it("handles Mar 1 in a leap year as day 061", () => {
    const d = new Date(2024, 2, 1);
    expect(formatMomentDate(d, "DDDD")).toBe("061");
  });

  it("handles Mar 1 in a non-leap year as day 060", () => {
    const d = new Date(2023, 2, 1);
    expect(formatMomentDate(d, "DDDD")).toBe("060");
  });

  it("handles Dec 31 in a leap year as day 366", () => {
    const d = new Date(2024, 11, 31);
    expect(formatMomentDate(d, "DDDD")).toBe("366");
  });

  it("handles Dec 31 in a non-leap year as day 365", () => {
    const d = new Date(2025, 11, 31);
    expect(formatMomentDate(d, "DDDD")).toBe("365");
  });

  it("treats 1900 as non-leap (century rule)", () => {
    const d = new Date(1900, 2, 1);
    expect(formatMomentDate(d, "DDDD")).toBe("060");
  });

  it("treats 2000 as leap (400-year rule)", () => {
    const d = new Date(2000, 2, 1);
    expect(formatMomentDate(d, "DDDD")).toBe("061");
  });
});

// ---------------------------------------------------------------------------
// O7: new moment tokens
// ---------------------------------------------------------------------------
describe("formatMomentDate — new tokens (O7)", () => {
  // Mon, May 11, 2026, 14:30:00 local — week 20 of ISO 2026.
  const may11 = new Date(2026, 4, 11, 14, 30, 0);
  // Thu, Apr 9, 2026, 05:07:03 local — also used in existing tests.
  const apr9 = new Date(2026, 3, 9, 5, 7, 3);

  it("handles A (uppercase AM/PM)", () => {
    expect(formatMomentDate(apr9, "A")).toBe("AM");
    expect(formatMomentDate(may11, "A")).toBe("PM");
    // Noon is PM, midnight is AM (moment semantics).
    expect(formatMomentDate(new Date(2026, 0, 1, 12), "A")).toBe("PM");
    expect(formatMomentDate(new Date(2026, 0, 1, 0), "A")).toBe("AM");
  });

  it("handles a (lowercase am/pm)", () => {
    expect(formatMomentDate(apr9, "a")).toBe("am");
    expect(formatMomentDate(may11, "a")).toBe("pm");
  });

  it("handles WW (zero-padded ISO week)", () => {
    // May 11, 2026 → ISO week 20.
    expect(formatMomentDate(may11, "WW")).toBe("20");
    // Jan 5, 2026 (a Monday) → ISO week 02.
    expect(formatMomentDate(new Date(2026, 0, 5), "WW")).toBe("02");
  });

  it("handles W (unpadded ISO week)", () => {
    expect(formatMomentDate(new Date(2026, 0, 5), "W")).toBe("2");
    expect(formatMomentDate(may11, "W")).toBe("20");
  });

  it("handles ww (week of year, padded)", () => {
    expect(formatMomentDate(may11, "ww")).toBe("20");
  });

  it("handles gggg / gg (ISO week-year)", () => {
    expect(formatMomentDate(may11, "gggg")).toBe("2026");
    expect(formatMomentDate(may11, "gg")).toBe("26");
    // Jan 1, 2023 was a Sunday — belongs to ISO week 52 of 2022.
    expect(formatMomentDate(new Date(2023, 0, 1), "gggg")).toBe("2022");
    expect(formatMomentDate(new Date(2023, 0, 1), "WW")).toBe("52");
  });

  it("handles E (ISO weekday, 1-7 Mon-Sun)", () => {
    expect(formatMomentDate(may11, "E")).toBe("1");          // Monday
    expect(formatMomentDate(apr9, "E")).toBe("4");           // Thursday
    expect(formatMomentDate(new Date(2026, 0, 4), "E")).toBe("7"); // Sunday
  });

  it("handles e (local weekday, 0-6 Sun-Sat)", () => {
    expect(formatMomentDate(may11, "e")).toBe("1");          // Monday
    expect(formatMomentDate(apr9, "e")).toBe("4");           // Thursday
    expect(formatMomentDate(new Date(2026, 0, 4), "e")).toBe("0"); // Sunday
  });

  it("handles X (unix timestamp seconds)", () => {
    const d = new Date(2026, 4, 11, 14, 30, 0);
    expect(formatMomentDate(d, "X")).toBe(String(Math.floor(d.getTime() / 1000)));
  });

  it("handles x (unix timestamp ms)", () => {
    const d = new Date(2026, 4, 11, 14, 30, 0);
    expect(formatMomentDate(d, "x")).toBe(String(d.getTime()));
  });

  it("round-trips a YYYY-[W]WW filename for May 11 2026", () => {
    // Common Obsidian weekly-note pattern. May 11 2026 is a Monday → W20.
    expect(formatMomentDate(may11, "YYYY-[W]WW")).toBe("2026-W20");
  });

  it("combines ISO week-year with week number across year boundary", () => {
    // Dec 30, 2024 (Mon) is ISO week 01 of 2025.
    const d = new Date(2024, 11, 30);
    expect(formatMomentDate(d, "gggg-[W]WW")).toBe("2025-W01");
  });
});

// ---------------------------------------------------------------------------
// Sanity: pre-existing tokens still behave (guard against new-token clashes)
// ---------------------------------------------------------------------------
describe("formatMomentDate — backward compatibility", () => {
  const d = new Date(2026, 3, 9, 5, 7, 3);

  it("still emits YYYY-MM-DD", () => {
    expect(formatMomentDate(d, "YYYY-MM-DD")).toBe("2026-04-09");
  });

  it("still leaves unsupported literals alone", () => {
    expect(formatMomentDate(d, "YYYY-?-DD")).toBe("2026-?-09");
  });

  it("still honors bracketed literals around new tokens", () => {
    expect(formatMomentDate(d, "[week] WW")).toBe("week 15");
  });
});
