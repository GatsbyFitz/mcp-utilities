/**
 * Does the ingest credential fail the way it is supposed to?
 *
 *   pnpm verify:ingest-secret
 *
 * `submit_schedule` is registered on `/mcp`, which is public. It is the only
 * public tool that will fetch a supplied URL from inside the deployment and
 * start a run, and the only thing standing between those two facts is
 * `MCP_INGEST_SECRET`. Every other tool there is advisory by construction.
 *
 * So the properties below are not stylistic. Three of them are the whole
 * design, and each fails silently if it regresses:
 *
 *   - **Unset means refuse, not allow.** An unconfigured deployment must not
 *     read as "no password required". This is the opposite of how
 *     `anthropicByok` degrades, and the two sit a few files apart.
 *   - **Offering nothing is not a failure.** No secret is the documented path
 *     and must queue, on a configured server and an unconfigured one alike.
 *   - **A wrong secret is refused, never downgraded to a queued request.** A
 *     caller that believed it was ingesting would otherwise report the quarter
 *     as loaded, with a row in a review queue as the only evidence against it.
 *
 * Offline, no credentials, no network: it sets the variable itself.
 */
import {
  INGEST_SECRET_ENV,
  MAX_SECRET_LENGTH,
  directIngestConfigured,
  ingestAuthority,
  secretMatches,
} from "@/lib/ingestSecret";
import {
  isDuplicatePendingSchedule,
  isMissingScheduleRequestsTable,
} from "@/lib/scheduleRequests";

let failed = false;
const fail = (message, detail) => {
  failed = true;
  console.log(`FAIL  ${message}${detail ? `\n      ${detail}` : ""}`);
};
const pass = (message) => console.log(`ok    ${message}`);
const check = (message, ok, detail) => (ok ? pass(message) : fail(message, detail));

const REAL = "s3cret-workbook-key-do-not-reuse";

/** Runs `body` with the variable set to `value`, or unset for null. */
function withSecret(value, body) {
  const before = process.env[INGEST_SECRET_ENV];
  if (value === null) delete process.env[INGEST_SECRET_ENV];
  else process.env[INGEST_SECRET_ENV] = value;
  try {
    body();
  } finally {
    if (before === undefined) delete process.env[INGEST_SECRET_ENV];
    else process.env[INGEST_SECRET_ENV] = before;
  }
}

console.log("With no secret configured — must fail closed:");
withSecret(null, () => {
  check("the server reports direct ingestion unconfigured", !directIngestConfigured());
  check("the real secret is still refused", !secretMatches(REAL));
  check("an empty string is refused", !secretMatches(""));
  check("undefined is refused", !secretMatches(undefined));
  check("null is refused", !secretMatches(null));
  // The failure that would matter most: an unset variable read as "open".
  check("no value whatsoever is accepted", !["", " ", "0", "false", "undefined", "null"].some(secretMatches));

  // Offering nothing still queues. An unconfigured server is not a broken one;
  // it simply cannot do the authorised path.
  check("offering no secret queues, it does not refuse",
    ingestAuthority(undefined).kind === "queue", JSON.stringify(ingestAuthority(undefined)));
  const offered = ingestAuthority(REAL);
  check("offering a secret is refused as not-configured",
    offered.kind === "refused" && offered.reason === "not-configured", JSON.stringify(offered));
});

console.log("\nWith a secret configured:");
withSecret(REAL, () => {
  check("the server reports direct ingestion available", directIngestConfigured());
  check("the exact secret matches", secretMatches(REAL));
  check("and authorises ingestion", ingestAuthority(REAL).kind === "ingest");

  check("a wrong secret does not match", !secretMatches("something-else"));
  const wrong = ingestAuthority("something-else");
  check("and is refused rather than queued",
    wrong.kind === "refused" && wrong.reason === "wrong-secret", JSON.stringify(wrong));

  // No secret is the default path even when one is configured.
  check("offering none still queues", ingestAuthority(undefined).kind === "queue");
  check("an empty string counts as offering none", ingestAuthority("").kind === "queue");

  // Nothing partial is accepted. A prefix comparison would make the secret
  // guessable one character at a time.
  check("a prefix is refused", !secretMatches(REAL.slice(0, -1)));
  check("a suffix is refused", !secretMatches(REAL.slice(1)));
  check("the secret with trailing whitespace is refused", !secretMatches(`${REAL} `));
  check("the secret with leading whitespace is refused", !secretMatches(` ${REAL}`));
  check("a case variant is refused", !secretMatches(REAL.toUpperCase()));
  check("a superstring is refused", !secretMatches(`${REAL}x`));

  // `timingSafeEqual` throws on a length mismatch, which is why both sides are
  // hashed to a fixed 32 bytes first. These are the inputs that would throw if
  // that ever changed to a raw comparison — a throw here reaches an MCP caller
  // as an unhandled error rather than a refusal.
  check("a one-character secret returns false rather than throwing",
    secretMatches("x") === false);
  check("a very long secret returns false rather than throwing",
    secretMatches("x".repeat(MAX_SECRET_LENGTH)) === false);
  check("past the length bound is refused without hashing",
    secretMatches("x".repeat(MAX_SECRET_LENGTH + 1)) === false);
  check("multi-byte input does not throw", secretMatches("日本語のパスワード") === false);
});

console.log("\nA secret that is only whitespace is still a configured secret:");
withSecret("   ", () => {
  check("it is reported as configured", directIngestConfigured());
  check("and it matches itself exactly", secretMatches("   "));
  check("while a trimmed version does not", !secretMatches(""));
});

// ---------------------------------------------------------------------------
// The two Postgres conditions submit_schedule has to recognise
// ---------------------------------------------------------------------------
// Checked here rather than against a database because both only ever happen on
// a real one, and both are caught by matching a driver message — the kind of
// thing that rots silently when a table or an index is renamed. Left
// unrecognised, the first reaches an unauthenticated caller as `relation
// "schedule_requests" does not exist` and the second as a constraint name:
// neither is something a model can act on, and neither belongs on a public
// endpoint. Same reasoning as `verify:sync-errors`.
console.log("\nRecognising the database conditions:");
{
  const missing = new Error(
    'relation "schedule_requests" does not exist, severity: ERROR, code: 42P01'
  );
  check("a missing table is recognised", isMissingScheduleRequestsTable(missing));
  check(
    "and is not confused with the document queue's table",
    !isMissingScheduleRequestsTable(new Error('relation "document_requests" does not exist'))
  );
  check(
    "an unrelated error is not read as a missing table",
    !isMissingScheduleRequestsTable(new Error("Error connecting to database: fetch failed"))
  );
  check(
    "a non-Error value does not throw",
    isMissingScheduleRequestsTable('relation "schedule_requests" does not exist')
  );

  const dupe = new Error(
    'duplicate key value violates unique constraint "schedule_requests_pending_idx"'
  );
  check("a duplicate pending request is recognised", isDuplicatePendingSchedule(dupe));
  check(
    "and is not confused with the document queue's index",
    !isDuplicatePendingSchedule(
      new Error(
        'duplicate key value violates unique constraint "document_requests_pending_title_idx"'
      )
    )
  );
  check(
    "another unique violation is not read as a duplicate request",
    !isDuplicatePendingSchedule(
      new Error(
        'duplicate key value violates unique constraint "aer_performance_observation_idx"'
      )
    )
  );
  check("a missing table is not read as a duplicate", !isDuplicatePendingSchedule(missing));
}

console.log(
  failed
    ? "\nSome submit_schedule gate checks FAILED."
    : "\nAll submit_schedule gate checks passed."
);
process.exit(failed ? 1 : 0);
