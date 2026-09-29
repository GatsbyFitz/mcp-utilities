// Verifies that POST /api/syncCompliance classifies a failure into something
// the operator can act on, rather than one sentence for every cause.
//
// This is the check that would have saved the bisection: the sync was failing
// because the Upstash index is hybrid and the compliance upsert sent no sparse
// vector. Upstash said exactly that; the route replaced it with "Could not
// sync the compliance tracker", and finding the real cause meant querying all
// three stores by hand.
//
// Offline, no credentials. Run: pnpm verify:sync-errors
import { describeSyncError, redact } from "@/lib/syncErrors";

let failures = 0;

function check(label, actual, expected) {
  const ok = typeof expected === "function" ? expected(actual) : actual === expected;
  if (!ok) {
    failures++;
    console.error(`  FAIL ${label}\n    got: ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok   ${label}`);
  }
}

// --- the failure that motivated all of this -------------------------------
{
  const upstash = new Error("This index requires sparse vectors");
  upstash.name = "UpstashError";
  const r = describeSyncError("vectors", upstash);
  console.log("Upstash hybrid-index rejection:");
  check("status is 502 (upstream, not ours)", r.status, 502);
  check("quotes Upstash verbatim", r.error, (e) => e.includes("This index requires sparse vectors"));
  check("names the stage", r.detail.stage, "vectors");
}

// --- Notion: the integration cannot see the database ----------------------
{
  const notFound = new Error("Could not find data source with ID: abc");
  notFound.name = "APIResponseError";
  notFound.code = "object_not_found";
  notFound.status = 404;
  const r = describeSyncError("notion", notFound);
  console.log("Notion object_not_found:");
  check("status is 502", r.status, 502);
  check("tells the operator to add the integration", r.error, (e) => e.includes("Connections"));
  check("keeps the provider code", r.detail.code, "object_not_found");
}

// --- our own un-provisioned table -----------------------------------------
{
  const missing = new Error('relation "compliance_actions" does not exist');
  const r = describeSyncError("database", missing);
  console.log("Missing compliance_actions table:");
  check("status is 500 (our fault, not theirs)", r.status, 500);
  check("names the .sql file to run", r.error, (e) => e.includes("db/compliance_actions.sql"));
}

// --- a Postgres error that is not the missing table -----------------------
{
  const sqlErr = new Error("value too long for type character varying(10)");
  sqlErr.code = "22001";
  const r = describeSyncError("database", sqlErr);
  console.log("Postgres SQLSTATE:");
  check("status is 500", r.status, 500);
  check("reports the SQLSTATE", r.error, (e) => e.includes("22001"));
}

// --- anything unrecognised still says something ---------------------------
{
  const r = describeSyncError("graph", new TypeError("x is not a function"));
  console.log("Unclassified error:");
  check("keeps the error name", r.error, (e) => e.startsWith("TypeError"));
  check("keeps the message", r.error, (e) => e.includes("x is not a function"));
}

// --- redaction is the backstop for returning provider text at all ---------
{
  console.log("Redaction:");
  check("strips a Notion token", redact("auth failed for ntn_1234567890abcdefghij"), (t) =>
    !t.includes("ntn_1234567890abcdefghij") && t.includes("[redacted]")
  );
  check("strips a bearer header", redact("Bearer abcdef0123456789abcdef"), (t) =>
    t.includes("[redacted]")
  );
  const leaked = describeSyncError("notion", new Error("bad token ntn_zzzzzzzzzzzzzzzzzzzz"));
  check("applies to what the route returns", leaked.error, (e) => !e.includes("ntn_zzzz"));
}

console.log(failures === 0 ? "\nAll sync-error checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
