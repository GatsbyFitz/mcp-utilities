import { isNotionClientError, APIErrorCode, ClientErrorCode } from "@notionhq/client";
import { APICallError } from "ai";
import { isMissingComplianceTable, MISSING_COMPLIANCE_MESSAGE } from "@/lib/compliance";

// ---------------------------------------------------------------------------
// Turning a sync failure into something the operator can act on
// ---------------------------------------------------------------------------
// `POST /api/syncCompliance` writes four upstream systems in sequence, and for
// a while it reported every one of their failures as the same sentence:
// "Could not sync the compliance tracker". Finding out that the Upstash index
// is hybrid and the compliance upsert was sending no sparse vector took a
// bisection across all three stores — while Upstash had said so precisely
// ("This index requires sparse vectors") and the route had thrown it away.
//
// So the rule here is: a provider that diagnosed itself gets quoted, not
// replaced. Only an error with nothing useful in it falls back to a generic
// message.
//
// This is a deliberate, scoped exception to the api-routes rule that a handler
// returns a generic message and logs the real one. That rule exists to keep
// connection strings and credentials out of a browser. This route is gated by
// `getToken` and `middleware.ts`, so its only reader is the operator — who can
// already see the logs. `redact` below is the backstop that keeps the
// exception honest if a provider ever puts a token in a message.

/** The phases of a sync, in the order the route runs them. */
export type SyncStage = "notion" | "embeddings" | "vectors" | "graph" | "database";

export interface SyncErrorReport {
  /** 502 when an upstream service failed, 500 when the fault is ours. */
  status: number;
  /** One actionable sentence, safe to render in the browser. */
  error: string;
  /** Structured fields for the operator; never contains secret material. */
  detail: Record<string, unknown>;
}

/**
 * Strips token-shaped substrings from anything we are about to return.
 *
 * No provider is expected to put a credential in an error message. This exists
 * so that if one ever does, the paragraph above does not quietly become false.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(?:ntn|secret|sk|pk|ghp|xox[abprs])_[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
}

/**
 * Notion errors, by identity *or* by shape.
 *
 * `isNotionClientError` is an `instanceof` check, so it returns false if the
 * bundle ever ends up holding two copies of the client. The symptom would be
 * this route falling back to an unclassified error — precisely what it exists
 * to prevent — so shape is accepted too.
 */
function asNotionError(
  error: unknown
): { code: string; status?: number } | null {
  if (isNotionClientError(error)) {
    return error as unknown as { code: string; status?: number };
  }
  const name = (error as { name?: unknown } | null)?.name;
  const code = (error as { code?: unknown } | null)?.code;
  const known =
    name === "APIResponseError" ||
    name === "RequestTimeoutError" ||
    name === "UnknownHTTPResponseError";
  return known && typeof code === "string"
    ? (error as { code: string; status?: number })
    : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A Postgres SQLSTATE, which Neon surfaces as a five-character `code`. */
function sqlState(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/**
 * Classifies a sync failure.
 *
 * Pure, and deliberately importing only `lib/compliance` (never `lib/db`, which
 * builds a client at module load), so it can be exercised with synthetic errors
 * offline and with no credentials — the same split as compliance/complianceStore.
 */
export function describeSyncError(stage: SyncStage, error: unknown): SyncErrorReport {
  const base = { stage, name: error instanceof Error ? error.name : typeof error };
  const raw = messageOf(error);

  // Ours, not theirs: the table is provisioned by hand, so name the file to run.
  // `isMissingComplianceTable` already existed for search_compliance; this route
  // simply never called it.
  if (isMissingComplianceTable(error)) {
    return { status: 500, error: MISSING_COMPLIANCE_MESSAGE, detail: base };
  }

  // Raised by fetchActions itself, and already written to be read by a person.
  if (raw.startsWith("Compliance Tracker schema")) {
    return { status: 502, error: redact(raw), detail: { ...base, code: "schema_mismatch" } };
  }

  const notion = asNotionError(error);
  if (notion) {
    const code = notion.code;
    const detail = { ...base, code, status: notion.status };

    if (code === APIErrorCode.ObjectNotFound) {
      return {
        status: 502,
        error:
          "The Notion integration cannot see the Compliance Tracker. In Notion, open the " +
          "database, then ··· → Connections, and add the integration that owns NOTION_TOKEN.",
        detail,
      };
    }
    if (code === APIErrorCode.Unauthorized || code === APIErrorCode.RestrictedResource) {
      return {
        status: 502,
        error: "Notion rejected NOTION_TOKEN — it is invalid or lacks access to this database.",
        detail,
      };
    }
    if (code === ClientErrorCode.RequestTimeout) {
      return { status: 502, error: "Notion timed out. Retry the sync.", detail };
    }
    // Every other Notion error names the field or the limit it is complaining
    // about, which is more use than anything this could substitute.
    return { status: 502, error: `Notion: ${redact(raw)}`, detail };
  }

  // The AI gateway. `responseBody` is deliberately not included: it can be large
  // and is not needed to act on the failure.
  if (APICallError.isInstance(error)) {
    return {
      status: 502,
      error: `The embedding call failed (HTTP ${error.statusCode ?? "?"}): ${redact(raw)}`,
      detail: { ...base, statusCode: error.statusCode, url: error.url },
    };
  }

  // Upstash. This is the one that started all of this: "This index requires
  // sparse vectors" is exactly what the operator needed to read.
  if (base.name === "UpstashError") {
    return { status: 502, error: `Upstash: ${redact(raw)}`, detail: base };
  }

  const state = sqlState(error);
  if (state) {
    return {
      status: 500,
      error: `The database rejected the write (SQLSTATE ${state}): ${redact(raw)}`,
      detail: { ...base, code: state },
    };
  }

  // Neo4j errors carry a dotted `code` such as Neo.ClientError.Statement.SyntaxError.
  const neoCode = (error as { code?: unknown } | null)?.code;
  if (typeof neoCode === "string" && neoCode.startsWith("Neo.")) {
    return { status: 502, error: `Neo4j: ${redact(raw)}`, detail: { ...base, code: neoCode } };
  }

  return {
    status: 500,
    error: raw ? `${base.name}: ${redact(raw)}` : "Could not sync the compliance tracker",
    detail: base,
  };
}
