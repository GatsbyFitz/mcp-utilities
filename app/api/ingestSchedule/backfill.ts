import { discoverWorkbooks, stageAndStartIngest } from "../upload/steps/backfillSchedules";
import type { StagedIngest } from "../upload/steps/backfillSchedules";
import type { Schedule } from "@/lib/aerPerformance";

export interface BackfillInput {
  /** Quarter labels to try, e.g. ["2023-24 Q3", "2023-24 Q4"]. */
  labels: string[];
  schedules: Schedule[];
}

/**
 * Back-fill the AER retail performance schedules across many quarters.
 *
 * Discovery once, then one step per workbook. The per-workbook loop is the
 * point: a step boundary per file means a quarter that fails — a renamed page,
 * a content type the spreadsheet kind refuses — retries by itself and does not
 * cost the ninety that worked. `ingestSchedule` is idempotent per
 * `(schedule, period_label)`, so re-running this resumes rather than doubles.
 *
 * Each workbook gets its own `ingestSchedule` run, so the actual parsing,
 * inference and writing is exactly the path a single hand-submitted quarter
 * takes. Nothing here re-implements it.
 */
export async function backfillSchedules(input: BackfillInput) {
  "use workflow";

  const discovered = await discoverWorkbooks(input.labels, input.schedules);

  const staged: StagedIngest[] = [];
  for (const workbook of discovered.workbooks) {
    staged.push(await stageAndStartIngest(workbook));
  }

  return {
    requested: input.labels.length * input.schedules.length,
    discovered: discovered.workbooks.length,
    started: staged.filter((s) => s.runId).length,
    failed: staged.filter((s) => s.error).length,
    skipped: discovered.skipped,
    staged,
  };
}
