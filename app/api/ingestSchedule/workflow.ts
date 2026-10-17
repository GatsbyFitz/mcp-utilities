import { readSheetPreviews, inferMappings, extractAndStore } from "../upload/steps/parseSchedule";
import type { Schedule } from "@/lib/aerPerformance";

export interface IngestScheduleInput {
  schedule: Schedule;
  /** "2023-24 Q3", as the AER writes it on the release. */
  periodLabel: string;
  blobUrl: string;
  fileName: string;
}

/**
 * Turn one AER schedule workbook into observations.
 *
 * Three steps because they fail for different reasons and cost different
 * amounts: reading the sheets is cheap and deterministic, inferring what the
 * columns mean is the only model call, and writing the rows is the only thing
 * that touches the database. A retry of the write must not re-pay for
 * inference — the same reasoning that keeps extractGraph separate from
 * createEmbeddings.
 */
export async function ingestSchedule(input: IngestScheduleInput) {
  "use workflow";

  const previews = await readSheetPreviews(input.blobUrl);
  const mappings = await inferMappings(input.schedule, previews);
  const result = await extractAndStore(
    input.blobUrl,
    input.schedule,
    input.periodLabel,
    input.fileName,
    mappings
  );

  return {
    fileName: input.fileName,
    schedule: input.schedule,
    periodLabel: input.periodLabel,
    sheets: mappings.length,
    ...result,
  };
}
