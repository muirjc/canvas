/**
 * canvas-zfe: turns what someone types in the History search box into the API's query.
 *
 * - A version number ("3", "v3", "V3", "#3") is sent as `q` (the API matches it exactly).
 * - A date is turned into a from/to range covering that whole day (or month) in the user's own
 *   time zone: the forms the list shows (its locale's numeric date, e.g. 10/26/2026 or 26/10/2026,
 *   with or without the time after it), ISO 2026-10-26, "Oct 26", "26 Oct", "October 2026",
 *   "today" and "yesterday". A date without a year means the most recent such day.
 * - Anything else is sent as `q` and matches the author's name or email.
 */
export interface VersionQuery {
  q?: string;
  from?: string;
  to?: string;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "Oct", "oct", "October" or "Sept" -> 9 / 8; anything that isn't a month name (or at least its
 *  first three letters) -> -1, so names like "Marvin" stay author searches. */
function monthIndex(word: string): number {
  const w = word.toLowerCase();
  if (w.length < 3) return -1;
  return MONTHS.findIndex((name) => name.startsWith(w) || (w === 'sept' && name === 'september'));
}

function dayRange(year: number, month: number, day: number): VersionQuery | null {
  const start = new Date(year, month, day);
  // Rejects 2/31 and the like: the Date constructor would silently roll it over.
  if (start.getFullYear() !== year || start.getMonth() !== month || start.getDate() !== day) return null;
  const end = new Date(year, month, day + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function monthRange(year: number, month: number): VersionQuery {
  return { from: new Date(year, month, 1).toISOString(), to: new Date(year, month + 1, 1).toISOString() };
}

/** With no year typed: this year, unless that day is still in the future, then last year. */
function withYear(month: number, day: number, now: Date): VersionQuery | null {
  const thisYear = now.getFullYear();
  const candidate = new Date(thisYear, month, day);
  return dayRange(candidate > now ? thisYear - 1 : thisYear, month, day);
}

/** Whether this locale writes numeric dates day-first (26/10/2026) rather than month-first. */
function dayFirst(locale?: string): boolean {
  const parts = new Intl.DateTimeFormat(locale).formatToParts(new Date(2026, 9, 26));
  return parts.findIndex((p) => p.type === 'day') < parts.findIndex((p) => p.type === 'month');
}

export function parseVersionQuery(text: string, now: Date = new Date(), locale?: string): VersionQuery {
  const input = text.trim();
  if (!input) return {};
  if (/^(?:v|#)?\s*\d+$/i.test(input)) return { q: input };

  const lower = input.toLowerCase();
  if (lower === 'today') return dayRange(now.getFullYear(), now.getMonth(), now.getDate())!;
  if (lower === 'yesterday') return yesterday(now);

  // The list shows "10/26/2026, 4:12:33 PM": only the date part matters.
  const datePart = input.split(',')[0].trim();

  let m = datePart.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return dayRange(Number(m[1]), Number(m[2]) - 1, Number(m[3])) ?? { q: input };

  m = datePart.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const [month, day] = dayFirst(locale) ? [b - 1, a] : [a - 1, b];
    if (m[3]) {
      const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return dayRange(year, month, day) ?? { q: input };
    }
    return withYear(month, day, now) ?? { q: input };
  }

  // "Oct 26", "October 26 2026", "Oct 26, 2026" (the comma split above keeps "Oct 26").
  m = input.replace(',', '').match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:\s+(\d{4}))?$/i);
  if (m && monthIndex(m[1]) >= 0) {
    const month = monthIndex(m[1]);
    return (m[3] ? dayRange(Number(m[3]), month, Number(m[2])) : withYear(month, Number(m[2]), now)) ?? { q: input };
  }
  // "26 Oct", "26 October 2026"
  m = input.match(/^(\d{1,2})\s+([a-z]{3,9})\.?(?:\s+(\d{4}))?$/i);
  if (m && monthIndex(m[2]) >= 0) {
    const month = monthIndex(m[2]);
    return (m[3] ? dayRange(Number(m[3]), month, Number(m[1])) : withYear(month, Number(m[1]), now)) ?? { q: input };
  }
  // "October 2026", "Oct 2026"
  m = input.match(/^([a-z]{3,9})\.?\s+(\d{4})$/i);
  if (m && monthIndex(m[1]) >= 0) return monthRange(Number(m[2]), monthIndex(m[1]));

  return { q: input };
}

function yesterday(now: Date): VersionQuery {
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return dayRange(y.getFullYear(), y.getMonth(), y.getDate())!;
}
