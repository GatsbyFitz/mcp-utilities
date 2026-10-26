import { createHash, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// The one credential that lets an MCP caller ingest rather than ask
// ---------------------------------------------------------------------------
// `/mcp` is public. Every other write it exposes is therefore either harmless
// or advisory: `request_document` stores a URL it will never fetch, precisely
// so that an unauthenticated tool cannot make this server fetch a supplied
// address from inside the deployment. See the comment at the top of
// request-document.ts.
//
// `submit_schedule` needs to do the thing that tool refuses to do — fetch a
// workbook and start a run — so it needs a caller it can hold responsible.
// This is that check.
//
// **It is not `APP_PASSWORD`.** Reusing the web login would be less to
// configure and much worse: an MCP tool argument travels through model
// context, client transcripts and whatever host is relaying the call, and a
// credential that also grants the whole signed-in UI is not something to put
// in that path. A scoped secret limits what a leak costs to "someone can
// queue an AER workbook", and lets it be rotated without locking anyone out
// of the app.

/** The environment variable holding it. Read here and nowhere else. */
export const INGEST_SECRET_ENV = "MCP_INGEST_SECRET";

/** Bounds what one call can send us to hash. */
export const MAX_SECRET_LENGTH = 512;

/**
 * Whether direct ingestion is configured at all.
 *
 * Worth asking separately from "is this secret right", because the two want
 * opposite messages: an unconfigured server should tell the operator to set
 * the variable, while a wrong secret should tell the caller nothing except
 * that it was wrong.
 */
export function directIngestConfigured(): boolean {
  return Boolean(process.env[INGEST_SECRET_ENV]);
}

/**
 * Constant-time comparison of a supplied secret against the configured one.
 *
 * **Fails closed.** With no `MAX_SECRET_LENGTH`-bounded value configured this
 * returns false for every input, including an empty one — an unset variable
 * can never mean "no password required". That is the opposite of how
 * `anthropicByok` degrades, deliberately: a missing billing credential is not
 * a reason to stop ingesting a document, and a missing authorisation
 * credential is not a reason to start one.
 *
 * Both sides are SHA-256'd before comparison rather than compared directly.
 * `timingSafeEqual` throws on a length mismatch, so comparing raw strings
 * would need a length check first — and that check would itself leak the
 * configured length through which inputs throw. Digests are always 32 bytes,
 * so every call does exactly the same work.
 */
export function secretMatches(supplied: string | undefined | null): boolean {
  const configured = process.env[INGEST_SECRET_ENV];
  if (!configured) return false;
  if (typeof supplied !== "string" || supplied.length === 0) return false;
  if (supplied.length > MAX_SECRET_LENGTH) return false;

  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(supplied), digest(configured));
}

/** What a caller is allowed to do with the credential it presented. */
export type IngestAuthority =
  /** No secret offered. The documented path: file a request for review. */
  | { kind: "queue" }
  /** A secret offered and accepted. Fetch and ingest now. */
  | { kind: "ingest" }
  /** A secret offered and refused, or offered to a server with none set. */
  | { kind: "refused"; reason: "wrong-secret" | "not-configured" };

/**
 * Classify a call before it does anything.
 *
 * The three outcomes are kept distinct because collapsing any two of them
 * loses something a caller has to know:
 *
 *  - **No secret → queue.** This is not a failure. It is what an ordinary
 *    client gets, and it is the behaviour `request_document` already has.
 *  - **Wrong secret → refused, nothing written.** Not quietly downgraded to a
 *    queued request. A caller that believed it was ingesting would otherwise
 *    report "ingested" to whoever asked, and the row sitting in a review queue
 *    would be the only trace. A wrong credential has to say so.
 *  - **Right secret → ingest.**
 *
 * The refusal distinguishes "that secret is wrong" from "this server has no
 * secret configured", which sounds like an oracle and is not one worth
 * withholding: the second is a deployment fact the operator needs, and it is
 * already observable — on an unconfigured server *every* secret is refused.
 */
export function ingestAuthority(supplied: string | undefined | null): IngestAuthority {
  const offered = typeof supplied === "string" && supplied.length > 0;
  if (!offered) return { kind: "queue" };
  if (!directIngestConfigured()) return { kind: "refused", reason: "not-configured" };
  return secretMatches(supplied)
    ? { kind: "ingest" }
    : { kind: "refused", reason: "wrong-secret" };
}
