# Running the AER ingestion

Everything is deployed and the tables are live. These run from a browser where
you are logged in to the app (DevTools → Network → copy as cURL gives you the
cookie), or paste the cookie into the commands below.

```bash
HOST=https://mcp-utilities.vercel.app
COOKIE='next-auth.session-token=<your session cookie>'
```

## 1. One workbook first

Schedule 2, Q4 2023–24. A real URL, captured from the AER's own document page.
This is the one that decides whether the column mapping works at all — nothing
before this point has ever run against a real workbook.

```bash
curl -s -X POST "$HOST/api/ingestSchedule" \
  -H 'Content-Type: application/json' -H "Cookie: $COOKIE" \
  -d '{
    "schedule": 2,
    "periodLabel": "2023-24 Q4",
    "sourceUrl": "https://www.aer.gov.au/system/files/2024-12/Schedule%202%20-%20Quarter%204%202023%E2%80%9324%20retail%20performance%20data.xlsm"
  }' | jq
```

Returns a `runId`. Track it on the upload page, or:

```bash
curl -s "$HOST/api/uploadStatus?runId=<runId>" -H "Cookie: $COOKIE" | jq
```

## 2. Check it before going further

```bash
# Row counts per metric, and the retailer spellings that were folded.
curl -s "$HOST/api/aerSummary" -H "Cookie: $COOKIE" | jq
```

Then read it back through the public MCP endpoint (no auth needed):

```bash
curl -s -X POST "$HOST/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
       "name":"search_aer_performance",
       "arguments":{"schedule":2,"periodLabel":"2023-24 Q4"}}}'
```

**What to look at, in order of what would hurt most if wrong:**

- **Pick one number and open the spreadsheet.** Every row carries
  `sheet_name` and `cell_ref`. Open that cell. This is the only check that
  catches a mapping that is confidently wrong.
- `retailerLabels` — are the folded spellings genuinely the same company?
  Anything that should be merged but is not goes in `aer_retailers`.
- Is any retailer obviously a **total**? It should have been refused; if one
  got through, `isAggregateLabel` needs the label added.
- `definitionsCaptured` on the run — if it is 0, the notes pages are not
  being read the way the prompt assumes, and the definitions feature is doing
  nothing. Worth knowing either way.
- `newMetrics` — expected to be everything on a first ingest.

## 3. One financial year of one schedule

```bash
# Dry run: see the targets, fetch nothing.
curl -s -X POST "$HOST/api/ingestSchedule/bulk" \
  -H 'Content-Type: application/json' -H "Cookie: $COOKIE" \
  -d '{"fromFyStart":2023,"toFyStart":2023,"schedules":[2],"dryRun":true}' | jq

# For real: 4 workbooks.
curl -s -X POST "$HOST/api/ingestSchedule/bulk" \
  -H 'Content-Type: application/json' -H "Cookie: $COOKIE" \
  -d '{"fromFyStart":2023,"toFyStart":2023,"schedules":[2]}' | jq
```

## 4. The rest

54 workbooks, 2021-22 Q1 to 2025-26 Q3. Re-running is safe —
`replaceScheduleRows` is idempotent per `(schedule, period_label)`, so this
also resumes a partial run.

```bash
curl -s -X POST "$HOST/api/ingestSchedule/bulk" \
  -H 'Content-Type: application/json' -H "Cookie: $COOKIE" \
  -d '{"fromFyStart":2021,"toFyStart":2025}' | jq
```

The response carries `skipped` with a reason per missing target:
`not-published` (Q4 2025-26, and every quarter before 2021-22, which uses an
older URL scheme), `requires-login` (2024-25 Q3, all three schedules), and
`no-workbook-link` / `ambiguous-links`, which would mean a page changed shape
and the discovery regex needs looking at.
