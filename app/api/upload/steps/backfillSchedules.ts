import { mapPool } from "@/lib/pool";
import { start } from "workflow/api";
import {
  SPREADSHEET_KIND,
  DocumentFetchError,
  downloadToBlob,
  fileNameFromUrl,
} from "@/lib/fetchDocument";
import type { Schedule } from "@/lib/aerPerformance";
import {
  type DiscoveredWorkbook,
  type DiscoverySkip,
  discoveryTargets,
  workbookFromPage,
} from "@/lib/aerReleases";
import { ingestSchedule } from "../../ingestSchedule/workflow";

// ---------------------------------------------------------------------------
// Steps: back-fill every published quarter of Schedules 2, 3 and 4
// ---------------------------------------------------------------------------
// One workbook is `ingestSchedule`. The whole history is ninety-odd of them,
// which is not a form to submit ninety times.
//
// Two steps, split where the costs are. Discovery is ninety small HTML GETs
// and no state; staging a workbook is a multi-megabyte download. A retry of
// one workbook must not re-walk the catalogue, and a catalogue change must not
// re-download anything.

/** Pages fetched at once. Polite to someone else's server, and fast enough. */
const DISCOVERY_CONCURRENCY = 4;

export interface DiscoveryResult {
  workbooks: DiscoveredWorkbook[];
  skipped: DiscoverySkip[];
}

/**
 * Step 1: which workbooks exist.
 *
 * **Not a second fetcher.** `downloadToBlob` exists to guard a *supplied* URL:
 * it resolves the hostname and checks the resolved addresses on every redirect
 * hop, because a server-side fetch of a user's URL leaves from inside the
 * deployment. Nothing here is supplied — the origin is the constant
 * `AER_ORIGIN` and the path is built from a label `periodBounds` has already
 * accepted, so there is no URL for a caller to point anywhere. The workbook
 * download in step 2 *is* a supplied URL by the time it is read off a page,
 * and that one goes through `downloadToBlob`.
 *
 * Every target that yields nothing is reported with a reason rather than
 * dropped. Walking a range is a guess at what the AER published, so "this
 * quarter is not there" is an ordinary outcome — but it must not read like
 * "this quarter's page changed shape", which is a bug in the regex.
 */
export async function discoverWorkbooks(
  labels: string[],
  schedules: Schedule[]
): Promise<DiscoveryResult> {
  "use step";

  const targets = discoveryTargets(labels, schedules);
  const outcomes = await mapPool(targets, DISCOVERY_CONCURRENCY, async (target) => {
    try {
      const res = await fetch(target.pageUrl, {
        headers: { accept: "text/html" },
        redirect: "follow",
      });
      const html = res.ok ? await res.text() : "";
      return workbookFromPage(
        target.schedule,
        target.periodLabel,
        target.pageUrl,
        res.status,
        html
      );
    } catch (error) {
      // A network failure is not "not published" — say which it was.
      return {
        skip: {
          schedule: target.schedule,
          periodLabel: target.periodLabel,
          pageUrl: target.pageUrl,
          reason: "not-published" as const,
          detail: error instanceof Error ? error.message : "fetch failed",
        },
      };
    }
  });

  const workbooks: DiscoveredWorkbook[] = [];
  const skipped: DiscoverySkip[] = [];
  for (const outcome of outcomes) {
    if ("workbook" in outcome) workbooks.push(outcome.workbook);
    else skipped.push(outcome.skip);
  }

  console.log(
    `[discoverWorkbooks] ${workbooks.length} workbooks from ${targets.length} pages; ` +
      `${skipped.length} skipped`
  );
  return { workbooks, skipped };
}

export interface StagedIngest {
  schedule: Schedule;
  periodLabel: string;
  sourceUrl: string;
  fileName?: string;
  runId?: string;
  error?: string;
}

/**
 * Step 2: one workbook into Blob, then its own `ingestSchedule` run.
 *
 * A nested run rather than inlining the parse steps, for the same reason
 * `POST /api/upload` starts one run per file: each workbook then retries,
 * reports and succeeds or fails on its own. `extractAndStore` is already
 * idempotent per `(schedule, period_label)`, so re-running one quarter
 * replaces it rather than doubling it, and a half-finished backfill is simply
 * resumed by running it again.
 *
 * Returns small. One `StagedIngest` per workbook goes in the workflow journal,
 * and the bytes must not — the reason `readSheetPreviews` re-opens the
 * workbook from Blob instead of being handed it.
 *
 * Never throws. One quarter the AER serves as HTML, or with a content type the
 * spreadsheet kind refuses, must not discard the eighty-nine that were fine.
 */
export async function stageAndStartIngest(workbook: DiscoveredWorkbook): Promise<StagedIngest> {
  "use step";

  const base: StagedIngest = {
    schedule: workbook.schedule,
    periodLabel: workbook.periodLabel,
    sourceUrl: workbook.sourceUrl,
  };

  try {
    const fileName = fileNameFromUrl(
      workbook.sourceUrl,
      `Schedule ${workbook.schedule} ${workbook.periodLabel}`,
      SPREADSHEET_KIND
    );
    // The supplied-URL path, so it goes through the checked fetcher.
    const uploaded = await downloadToBlob(workbook.sourceUrl, fileName, SPREADSHEET_KIND);

    const run = await start(ingestSchedule, [
      {
        schedule: workbook.schedule,
        periodLabel: workbook.periodLabel,
        blobUrl: uploaded.url,
        fileName: uploaded.fileName,
      },
    ]);
    return { ...base, fileName: uploaded.fileName, runId: run.runId };
  } catch (error) {
    const message =
      error instanceof DocumentFetchError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Unknown error";
    console.warn(
      `[stageAndStartIngest] Schedule ${workbook.schedule} ${workbook.periodLabel}: ${message}`
    );
    return { ...base, error: message };
  }
}
