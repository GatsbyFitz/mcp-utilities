import { SCHEDULES, periodBounds, type Schedule } from "@/lib/aerPerformance";

// ---------------------------------------------------------------------------
// Finding the workbooks: what the AER publishes, and where
// ---------------------------------------------------------------------------
// `ingestSchedule` takes one workbook and one period. Backfilling every quarter
// of Schedules 2, 3 and 4 means roughly ninety of them, which is not a form to
// submit ninety times — so the list has to be discovered rather than typed.
//
// It cannot be computed. The asset path carries the *publication* month, which
// has no fixed relationship to the quarter it reports on, and the extension
// varies because the AER ships .xlsm as readily as .xlsx:
//
//   /system/files/2024-12/Schedule 2 - Quarter 4 2023–24 retail performance data.xlsm
//                 ^^^^^^^ published Dec 2024, reports Apr–Jun 2024    ^^^^
//
// Note the en-dash in the file name against the hyphen in the page URL below.
// That asymmetry is the reason this module never builds a file name: it builds
// the *page* URL, which is regular, and reads the file URL off the page.
//
// The discovery fetch runs server-side, and that is not incidental. AEMO aside,
// this is the second case of a host the deployment can reach and a developer
// container cannot: aer.gov.au answers Vercel's Sydney region in under a second
// and is refused outright from the agent proxy. Discovery therefore belongs in
// the app, not in a script someone runs locally.

/** Where every AER page lives. Centralised so a host move is one edit. */
export const AER_ORIGIN = "https://www.aer.gov.au";

/**
 * The page for one schedule in one quarter.
 *
 * Document pages, never release pages — and that is not a preference. The
 * release pages (`/publications/reports/performance/...`) sit behind Akamai
 * Bot Manager: every one of them answers **200** with the same 2,489-byte
 * `bm-verify` interstitial, including URLs that cannot exist. Probing
 * `...-update-quarter-9-2019-20` returns exactly what a real quarter returns,
 * so a discovery walk over them would report every quarter as found and then
 * report every one as having no workbook link — thirty-six invented parser
 * bugs. The `/documents/` path is not gated: a real page is ~72 KB and a
 * missing one is a real 404, which is the only reason any of this is
 * decidable.
 *
 * There are **two slug forms**, and they are mutually exclusive — no quarter
 * answers on both. The AER renamed the pattern between 2020-21 Q3 and
 * 2021-22 Q1:
 *
 *   `schedule-2-q3-2020-21-retail-performance-data`       2018-19 Q3 → 2020-21 Q3
 *   `schedule-2-quarter-1-2021-22-retail-performance-data` 2021-22 Q1 → present
 *
 * `documentPageUrls` returns both, likeliest first for the era, rather than
 * switching on a hardcoded cutoff year. A cutoff would be a prediction about
 * the next rename, and the cost of being wrong is a silent miss; trying the
 * other form costs one extra 404 on a page that was going to be fetched
 * anyway. Ordering keeps the common case at one request.
 *
 * Hyphens, not en-dashes: the page URL uses `2023-24` even where the file name
 * inside it uses `2023–24`.
 */
export function documentPageUrls(schedule: Schedule, label: string): string[] {
  const parsed = parseLabel(label);
  if (!parsed) return [];
  const { fy, quarter } = parsed;
  const slug = (q: string) =>
    `${AER_ORIGIN}/documents/schedule-${schedule}-${q}-${fy}-retail-performance-data`;

  const long = slug(`quarter-${quarter}`);
  const short = slug(`q${quarter}`);

  // The era boundary decides the *order*, not the set. `2021` reads off the
  // financial year's first half, which is what the slug carries.
  const fyStart = Number(fy.slice(0, 4));
  return fyStart >= 2021 ? [long, short] : [short, long];
}

/**
 * The likeliest page for one schedule and quarter.
 *
 * Kept for callers that want one URL to name — an error message, a label on a
 * skip. Discovery uses `documentPageUrls` and tries both.
 */
export function documentPageUrl(schedule: Schedule, label: string): string | null {
  return documentPageUrls(schedule, label)[0] ?? null;
}

/** `2023-24 Q4` → `{ fy: "2023-24", quarter: 4 }`, or null. */
export function parseLabel(label: string): { fy: string; quarter: number } | null {
  const m = label.trim().match(/^(\d{4})\s*[-–/]\s*(\d{2,4})\s*Q([1-4])$/i);
  if (!m) return null;
  // Normalise the second year to two digits, which is what the URLs use.
  const second = m[2].length === 4 ? m[2].slice(2) : m[2].padStart(2, "0");
  return { fy: `${m[1]}-${second}`, quarter: Number(m[3]) };
}

/** The canonical label for a financial year and quarter. */
export function quarterLabel(fyStartYear: number, quarter: number): string {
  const second = String((fyStartYear + 1) % 100).padStart(2, "0");
  return `${fyStartYear}-${second} Q${quarter}`;
}

/**
 * Every quarter label from one financial year to another, inclusive and in
 * order. `periodBounds` is the gate — a label it cannot parse is not emitted,
 * so nothing downstream has to re-check.
 *
 * `asOf` drops quarters that have not finished yet. Without it a range that
 * ends at the current financial year emits up to three quarters that cannot
 * exist, and every one becomes a "not published" skip — which is the same
 * line a quarter whose page was renamed produces. Twelve predictable misses
 * would bury the one that means the regex is wrong.
 *
 * It deliberately does *not* try to model publication lag. The AER runs
 * several months behind the quarter end, so recently-finished quarters will
 * also be absent; that is a real "not yet published" and belongs in the
 * report. Only the arithmetically impossible is filtered here.
 */
export function quarterLabelsBetween(
  fromFyStart: number,
  toFyStart: number,
  asOf?: Date
): string[] {
  const cutoff = asOf ? asOf.toISOString().slice(0, 10) : null;
  const labels: string[] = [];
  for (let y = fromFyStart; y <= toFyStart; y++) {
    for (let q = 1; q <= 4; q++) {
      const label = quarterLabel(y, q);
      const bounds = periodBounds(label);
      if (!bounds) continue;
      if (cutoff && bounds.end > cutoff) continue;
      labels.push(label);
    }
  }
  return labels;
}

/** One workbook to ingest: what it is, and where to get it. */
export interface DiscoveredWorkbook {
  schedule: Schedule;
  periodLabel: string;
  /** Absolute URL of the .xlsx/.xlsm asset. */
  sourceUrl: string;
  /** The page it was found on, kept so a wrong link is traceable. */
  pageUrl: string;
}

/**
 * The workbook link on a document page.
 *
 * Deliberately narrow: it takes the first `.xlsx`/`.xlsm` href and nothing
 * else. A document page carries exactly one workbook, so a page that yields
 * several is a page whose shape has changed — and `discoverWorkbooks` reports
 * that rather than picking one and hoping.
 *
 * Returns every match so the caller can tell "none" from "ambiguous". Those
 * are different failures: the first is a missing or renamed quarter, the
 * second is a layout change that would make any single pick a guess.
 */
export function workbookHrefs(html: string): string[] {
  const found: string[] = [];
  const re = /href\s*=\s*["']([^"']+\.(?:xlsx|xlsm))["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/**
 * Resolve a possibly-relative href against the AER origin.
 *
 * Returns null for anything that resolves off-origin. A workbook link that
 * points somewhere else is not a workbook link worth following: the fetch that
 * follows runs from inside the deployment, so the set of hosts it will visit
 * stays closed here as well as in `downloadToBlob`.
 */
export function resolveWorkbookUrl(href: string): string | null {
  try {
    const url = new URL(href, AER_ORIGIN);
    if (url.protocol !== "https:") return null;
    if (url.hostname !== new URL(AER_ORIGIN).hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A document the AER has put behind its login.
 *
 * Observed on all three schedules for 2024-25 Q3: the page answers **200**
 * with a 682-byte interstitial reading "Redirecting to
 * /user/login?destination=…", so `redirect: "follow"` does not help and the
 * body simply contains no workbook link.
 *
 * It needs its own reason. Left as `no-workbook-link` it reads as "the page
 * shape changed and the regex missed", which would send someone to debug a
 * parser over a quarter that is merely gated.
 */
export function requiresLogin(html: string): boolean {
  return /\/user\/login\?destination=/.test(html);
}

/** Why one (schedule, quarter) yielded nothing. Reported, never silent. */
export type SkipReason =
  | "not-published"
  | "requires-login"
  | "no-workbook-link"
  | "ambiguous-links"
  | "off-origin-link";

export interface DiscoverySkip {
  schedule: Schedule;
  periodLabel: string;
  pageUrl: string;
  reason: SkipReason;
  detail?: string;
}

/**
 * Turn one fetched document page into a workbook, or into a stated reason.
 *
 * Pure, so the whole decision is testable without the network: the caller does
 * the fetching and hands the status and body in.
 */
export function workbookFromPage(
  schedule: Schedule,
  periodLabel: string,
  pageUrl: string,
  status: number,
  html: string
): { workbook: DiscoveredWorkbook } | { skip: DiscoverySkip } {
  const skip = (reason: SkipReason, detail?: string) => ({
    skip: { schedule, periodLabel, pageUrl, reason, detail },
  });

  // A quarter the AER has not published, or has published under another name.
  // Not an error: the range being walked is a guess at what exists.
  if (status === 404) return skip("not-published", `HTTP ${status}`);
  if (status < 200 || status >= 300) return skip("not-published", `HTTP ${status}`);

  // Checked before the link scan: a gated page has no link *because* it is
  // gated, and reporting the absence would describe the symptom not the cause.
  if (requiresLogin(html)) return skip("requires-login");

  const hrefs = workbookHrefs(html);
  if (hrefs.length === 0) return skip("no-workbook-link");
  if (hrefs.length > 1) return skip("ambiguous-links", hrefs.slice(0, 3).join(" | "));

  const sourceUrl = resolveWorkbookUrl(hrefs[0]);
  if (!sourceUrl) return skip("off-origin-link", hrefs[0]);

  return { workbook: { schedule, periodLabel, sourceUrl, pageUrl } };
}

/** One (schedule, quarter) to look for, and every URL it might live at. */
export interface DiscoveryTarget {
  schedule: Schedule;
  periodLabel: string;
  /** Candidate page URLs, likeliest first. Tried in order; first hit wins. */
  pageUrls: string[];
}

/**
 * Every (schedule, quarter) pair to try, in a stable order.
 *
 * One target per pair rather than per URL, so a quarter that answers on the
 * second slug form is one outcome and not one hit plus one spurious
 * "not published" — which is the whole reason the two forms are a list inside
 * a target instead of two targets.
 */
export function discoveryTargets(
  labels: string[],
  schedules: readonly Schedule[] = SCHEDULES
): DiscoveryTarget[] {
  const targets: DiscoveryTarget[] = [];
  for (const periodLabel of labels) {
    for (const schedule of schedules) {
      const pageUrls = documentPageUrls(schedule, periodLabel);
      if (pageUrls.length > 0) targets.push({ schedule, periodLabel, pageUrls });
    }
  }
  return targets;
}

/**
 * A backfill is a lot of requests at someone else's expense, so it is bounded.
 * Ninety-odd document pages plus the workbooks themselves is already the whole
 * published history; anything much larger is a mistake in the range.
 *
 * Counted in (schedule, quarter) targets, not requests: a target may try two
 * slug forms, so the request ceiling is twice this in the worst case.
 */
export const MAX_BACKFILL_TARGETS = 200;

/**
 * The first financial year the AER published these schedules for.
 *
 * 2018 is right, but the year does not start at Q1: probing every quarter of
 * every schedule found nothing for 2018-19 Q1 or Q2 on either slug form, and
 * the series begins at **2018-19 Q3**. Two other holes are real rather than
 * pattern failures, and are worth knowing before someone goes looking for a
 * bug: **2019-20 Q1 has no Schedule 4** (Schedules 2 and 3 are both there),
 * and **2020-21 Q4 is absent for all three schedules on both forms** — it
 * falls exactly on the rename, which is suggestive but not something this code
 * can work around. Each reports as `not-published`, which is what it is.
 */
export const EARLIEST_FY_START = 2018;
