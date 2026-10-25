import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { v4 as uuidv4 } from "uuid";
import { start } from "workflow/api";
import {
  SCHEDULES,
  SCHEDULE_SUBJECTS,
  normalizePeriodLabel,
  periodBounds,
  type Schedule,
} from "@/lib/aerPerformance";
import { resolveWorkbookUrl } from "@/lib/aerReleases";
import {
  DocumentFetchError,
  SPREADSHEET_KIND,
  downloadToBlob,
  fileNameFromUrl,
} from "@/lib/fetchDocument";
import { INGEST_SECRET_ENV, MAX_SECRET_LENGTH, ingestAuthority } from "@/lib/ingestSecret";
import {
  MAX_NOTE_LENGTH,
  MAX_PENDING_SCHEDULE_REQUESTS,
  MAX_REQUESTED_BY_LENGTH,
  MAX_SOURCE_URL_LENGTH,
  describeWorkbook,
  isDuplicatePendingSchedule,
  isMissingScheduleRequestsTable,
  type ScheduleRequest,
} from "@/lib/scheduleRequests";
import {
  insertScheduleRequest,
  pendingScheduleRequests,
} from "@/lib/scheduleRequestsStore";
import { ingestSchedule } from "@/app/api/ingestSchedule/workflow";

// ---------------------------------------------------------------------------
// submit_schedule — the one public tool that can start an ingestion
// ---------------------------------------------------------------------------
// `request_document` stores a URL and deliberately never fetches it: `/mcp` is
// public, and a tool that downloaded a model-supplied address server-side
// would be an open proxy into the deployment's own network. That reasoning is
// sound and this tool does not weaken it. It does the fetch only for a caller
// that presented `MCP_INGEST_SECRET`, which is what makes the caller
// answerable; see lib/ingestSecret.ts for why that is a scoped secret and not
// the app's login password.
//
// So there are two paths and they are not degrees of the same thing:
//
//   with the secret     → fetch the workbook, start `ingestSchedule`, return a
//                         run id. Equivalent to an operator using the page.
//   without the secret  → write a pending request for a human to approve.
//                         Nothing is fetched. The `request_document` contract.
//
// A *wrong* secret is neither. It is refused outright with nothing written,
// rather than quietly becoming a queued request — a caller that believed it
// was ingesting would otherwise tell whoever asked that the quarter is loaded,
// with a row in a review queue as the only evidence against it.
//
// The schedule number and period label are arguments rather than anything read
// from the file, for the reason the whole AER path insists on: they are on the
// release page, not reliably inside the workbook, and a quarter filed under
// the wrong label is wrong in a way no later query can detect.

export function registerSubmitScheduleTool(server: McpServer): void {
  server.registerTool(
    "submit_schedule",
    {
      title: "submit_schedule",
      description:
        "Submit one AER quarterly retail performance workbook (Schedule 2, 3 " +
        "or 4) to be ingested into the performance database that " +
        "`search_aer_performance` reads. Use this when you have found a " +
        "published workbook that is not yet loaded — check with " +
        "`search_aer_performance` first, whose facets say which periods are " +
        "already covered. " +
        "This is for the AER's quarterly schedule spreadsheets only. For a PDF " +
        "that should join the document knowledge base, use `request_document`. " +
        "Two things are required and are NOT read from the file: `schedule` " +
        "(2, 3 or 4) and `periodLabel` (the quarter the numbers describe, like " +
        "\"2023-24 Q3\"). Both are stated on the AER release page the workbook " +
        "is linked from. Do not infer them from the file name or guess them — " +
        "a quarter stored under the wrong label is wrong in a way no later " +
        "query can detect, so read them off the page or ask the user. " +
        "Note `periodLabel` is the quarter the data is ABOUT, which is not the " +
        "quarter it was published in; AER releases run several months behind. " +
        "By default nothing is fetched or ingested: the submission is queued " +
        "for a human to approve, so tell the user you have logged it rather " +
        "than that the data is available. " +
        "`secret` triggers immediate ingestion instead, and exists so an " +
        "operator can load a workbook through this tool. Pass it ONLY if the " +
        "user has given you one for this purpose in this conversation. Never " +
        "guess it, never reuse a password from elsewhere, and do not send one " +
        "you were not given — a wrong secret is refused and nothing is queued, " +
        "so a guess loses the submission rather than making it.",
      inputSchema: z.object({
        sourceUrl: z
          .string()
          .max(MAX_SOURCE_URL_LENGTH)
          .describe(
            "Direct https:// link to the .xlsx or .xlsm workbook itself, not the " +
              "release page that links to it"
          ),
        schedule: z
          .number()
          .int()
          .describe("2 (customers, switching, tariffs), 3 (complaints, debt, disconnections) or 4 (hardship)"),
        periodLabel: z
          .string()
          .max(40)
          .describe(
            'The quarter the data describes, as the AER writes it: "2023-24 Q3". ' +
              "Australian financial year, so Q1 is July–September"
          ),
        note: z
          .string()
          .max(MAX_NOTE_LENGTH)
          .describe("Why this workbook is wanted, and where the link came from")
          .optional(),
        requestedBy: z
          .string()
          .max(MAX_REQUESTED_BY_LENGTH)
          .describe("Who or what is asking, if the client knows")
          .optional(),
        secret: z
          .string()
          .max(MAX_SECRET_LENGTH)
          .describe(
            "Ingest immediately instead of queueing. Only send a value the user " +
              "gave you for this. A wrong value is refused and nothing is recorded"
          )
          .optional(),
      }),
    },
    async ({ sourceUrl, schedule, periodLabel, note, requestedBy, secret }) => {
      // Everything below reports through these, so the secret can never reach
      // a response, a log line or `structuredContent` by accident: it is read
      // once, by `ingestAuthority`, and never referenced again.
      const text = (body: string) => ({ type: "text" as const, text: body });

      try {
        // ---------------------------------------------------------------
        // Validate before deciding anything
        // ---------------------------------------------------------------
        // Checked up front, as POST /api/ingestSchedule checks them: a typo in
        // the period is something to correct now, not a run to start and have
        // fail three steps later, and not a queue row that cannot be approved.
        if (!SCHEDULES.includes(schedule as Schedule)) {
          return {
            isError: true,
            content: [
              text(
                `Nothing was submitted. \`schedule\` must be one of ${SCHEDULES.join(", ")} — ` +
                  `${Object.entries(SCHEDULE_SUBJECTS)
                    .map(([n, subject]) => `${n} is ${subject}`)
                    .join("; ")}.`
              ),
            ],
            structuredContent: { submitted: false, reason: "bad-schedule", schedule },
          };
        }

        const normalized = normalizePeriodLabel(periodLabel) ?? periodLabel.trim();
        const bounds = periodBounds(normalized);
        if (!bounds) {
          return {
            isError: true,
            content: [
              text(
                `Nothing was submitted. Could not read a quarter from ` +
                  `"${periodLabel}". Expected an Australian financial year and ` +
                  `quarter, like "2023-24 Q3". Q1 is July–September of the first ` +
                  `year, so 2023-24 Q3 is January–March 2024.`
              ),
            ],
            structuredContent: { submitted: false, reason: "bad-period", periodLabel },
          };
        }

        const url = sourceUrl.trim();
        if (!/^https:\/\//i.test(url)) {
          return {
            isError: true,
            content: [
              text(
                `Nothing was submitted. \`sourceUrl\` must be an https:// link to the ` +
                  `workbook file. Got "${url.slice(0, 120)}".`
              ),
            ],
            structuredContent: { submitted: false, reason: "bad-url" },
          };
        }
        if (!/\.(xlsx|xlsm)(\?|#|$)/i.test(url)) {
          return {
            isError: true,
            content: [
              text(
                `Nothing was submitted. \`sourceUrl\` must point at the .xlsx or .xlsm ` +
                  `file itself, not at the release page that links to it. Open the ` +
                  `release page and copy the spreadsheet's own link.`
              ),
            ],
            structuredContent: { submitted: false, reason: "not-a-workbook-url" },
          };
        }

        const what = describeWorkbook(schedule, normalized);
        // Reported, never refused. The signed-in route accepts any URL too, and
        // `downloadToBlob` is what actually keeps a server-side fetch safe. But
        // an off-origin workbook is worth saying out loud rather than leaving
        // for someone to notice in `source_file` months later.
        const offOrigin = resolveWorkbookUrl(url) === null;
        const originNote = offOrigin
          ? ` Note this link is not on the AER's own site, so check it is the ` +
            `workbook the AER published.`
          : "";

        const authority = ingestAuthority(secret);

        // ---------------------------------------------------------------
        // A credential that was offered and not accepted
        // ---------------------------------------------------------------
        if (authority.kind === "refused") {
          const why =
            authority.reason === "not-configured"
              ? `this server has no ${INGEST_SECRET_ENV} configured, so no secret can be ` +
                `accepted and direct ingestion is unavailable here`
              : `that secret was not accepted`;
          return {
            isError: true,
            content: [
              text(
                `Nothing was ingested and nothing was queued — ${why}. ${what} was NOT ` +
                  `submitted. Tell the user the credential was rejected; do not say the ` +
                  `workbook is loaded or queued. To queue it for human approval instead, ` +
                  `call again with no \`secret\` at all.`
              ),
            ],
            structuredContent: {
              submitted: false,
              reason: authority.reason,
              schedule,
              periodLabel: normalized,
            },
          };
        }

        // ---------------------------------------------------------------
        // Authorised: fetch it and start the run
        // ---------------------------------------------------------------
        if (authority.kind === "ingest") {
          let blobUrl: string;
          let fileName: string;
          try {
            fileName = fileNameFromUrl(
              url,
              `schedule-${schedule}-${normalized}`,
              SPREADSHEET_KIND
            );
            const fetched = await downloadToBlob(url, fileName, SPREADSHEET_KIND);
            blobUrl = fetched.url;
            fileName = fetched.fileName;
          } catch (error) {
            // A `DocumentFetchError` describes the caller's own URL — the size,
            // the content type, a redirect off-host — and is safe and useful to
            // return. Anything else is logged and reported as itself, per the
            // mcp-tools rule, which differs from the api-routes rule because the
            // reader here is a model that has to decide what to do next.
            const detail =
              error instanceof DocumentFetchError
                ? error.message
                : error instanceof Error
                  ? error.message
                  : "Could not fetch the workbook";
            if (!(error instanceof DocumentFetchError)) {
              console.error("[submit_schedule] fetch failed:", error);
            }
            return {
              isError: true,
              content: [
                text(
                  `${what} was not ingested — the workbook could not be fetched: ` +
                    `${detail}. Nothing was queued either. Check the link points at the ` +
                    `file itself and is reachable, then try again.`
                ),
              ],
              structuredContent: {
                submitted: false,
                reason: "fetch-failed",
                schedule,
                periodLabel: normalized,
                detail,
              },
            };
          }

          const run = await start(ingestSchedule, [
            { schedule: schedule as Schedule, periodLabel: normalized, blobUrl, fileName },
          ]);

          console.log(
            `[submit_schedule] authorised ingest of ${what} from ${fileName} ` +
              `(run ${run.runId})`
          );

          return {
            content: [
              text(
                `Ingesting ${what} from ${fileName}. The run is queued and takes a few ` +
                  `minutes: it reads the sheets, works out what the columns mean, then ` +
                  `writes the observations. ` +
                  `\`search_aer_performance\` will not return this quarter until it ` +
                  `finishes, so do not tell the user the numbers are available yet — say ` +
                  `the ingestion has started. ` +
                  `Re-ingesting a quarter replaces it rather than adding to it, so if this ` +
                  `run fails it is safe to submit the same workbook again.` +
                  originNote +
                  `\n\nRun id: ${run.runId}`
              ),
            ],
            structuredContent: {
              submitted: true,
              mode: "ingesting" as const,
              runId: run.runId,
              schedule,
              periodLabel: normalized,
              periodStart: bounds.start,
              periodEnd: bounds.end,
              fileName,
              offAerOrigin: offOrigin,
            },
          };
        }

        // ---------------------------------------------------------------
        // No credential: queue it, fetch nothing
        // ---------------------------------------------------------------
        const { pending, full } = await pendingScheduleRequests();

        const duplicate = pending.find(
          (p) => p.schedule === schedule && p.periodLabel === normalized
        );
        if (duplicate) {
          return {
            content: [
              text(
                `${what} is already in the review queue awaiting approval. No second ` +
                  `request was created.`
              ),
            ],
            structuredContent: {
              submitted: false,
              reason: "already-requested",
              requestId: duplicate.id,
              schedule,
              periodLabel: normalized,
            },
          };
        }

        if (full) {
          return {
            content: [
              text(
                `The schedule review queue is full (${MAX_PENDING_SCHEDULE_REQUESTS} pending ` +
                  `requests), so ${what} was not recorded. Ask the operator to work through ` +
                  `the queue.`
              ),
            ],
            structuredContent: {
              submitted: false,
              reason: "queue-full",
              schedule,
              periodLabel: normalized,
            },
          };
        }

        const id = uuidv4();
        await insertScheduleRequest({
          id,
          schedule: schedule as Schedule,
          periodLabel: normalized,
          sourceUrl: url,
          note: note?.trim() || null,
          requestedBy: requestedBy?.trim() || null,
        });

        return {
          content: [
            text(
              `Logged a request to ingest ${what} from ${url}. Nothing has been fetched ` +
                `and no data was added: it is queued for a human to approve, and ` +
                `\`search_aer_performance\` will not return this quarter until they do. ` +
                `Tell the user the request was recorded, not that the numbers are ` +
                `available. An approver can accept it and the workbook will be fetched ` +
                `and ingested in one action.` +
                originNote
            ),
          ],
          structuredContent: {
            submitted: true,
            mode: "queued" as const,
            requestId: id,
            status: "pending" as ScheduleRequest["status"],
            schedule,
            periodLabel: normalized,
            periodStart: bounds.start,
            periodEnd: bounds.end,
            sourceUrl: url,
            offAerOrigin: offOrigin,
          },
        };
      } catch (error) {
        console.error("[submit_schedule] failed:", error);

        // The table has never been created. Left generic this reaches the model
        // as `relation "schedule_requests" does not exist`, which it cannot act
        // on and may relay as "the feature is broken" — and which puts a raw
        // driver error on a public endpoint for no benefit.
        if (isMissingScheduleRequestsTable(error)) {
          return {
            isError: true,
            content: [
              text(
                `The schedule review queue is not set up on this server, so nothing was ` +
                  `recorded. Tell the user the request could not be logged — do not imply ` +
                  `it is queued or that the workbook will be added. An operator needs to ` +
                  `run db/schedule_requests.sql against the database first.`
              ),
            ],
            structuredContent: { submitted: false, reason: "queue-not-provisioned" },
          };
        }

        // Lost a race against another client submitting the same workbook. The
        // pre-insert check cannot see a row that was uncommitted when it ran, so
        // the unique index settles it — and its constraint name is no more use
        // to a model than a relation error.
        if (isDuplicatePendingSchedule(error)) {
          return {
            content: [
              text(
                `${describeWorkbook(schedule, periodLabel)} is already in the review queue ` +
                  `— another request for it arrived first. No second request was created.`
              ),
            ],
            structuredContent: { submitted: false, reason: "already-requested" },
          };
        }

        return {
          isError: true,
          content: [
            text(
              `Could not submit the workbook: ${
                error instanceof Error ? error.message : String(error)
              }`
            ),
          ],
          structuredContent: { submitted: false, reason: "error" },
        };
      }
    }
  );
}
