import { lookup } from "node:dns/promises";
import { put } from "@vercel/blob";
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  uploadPathname,
  type UploadedFile,
} from "./upload";

// ---------------------------------------------------------------------------
// Fetching an approved document by URL.
//
// The URL originates from `request_document`, which any MCP client can call
// without authenticating. A signed-in human has to approve it before anything
// is fetched, but "an authenticated user pressed a button" does not make a
// server-side fetch of an attacker-chosen URL safe: the request leaves from
// inside the deployment, where it can reach link-local metadata endpoints and
// anything else not exposed to the internet. So every hop is validated, not
// just the one that was typed in.
// ---------------------------------------------------------------------------

/** A refusal the operator should see, as opposed to an internal failure. */
export class DocumentFetchError extends Error {}

const MAX_REDIRECTS = 5;

/**
 * Address ranges a fetch must never reach. Checked against the *resolved*
 * addresses, not the hostname — a name under an attacker's control can point
 * anywhere, and can point somewhere different on the second lookup.
 */
function isBlockedAddress(address: string, family: number): boolean {
  if (family === 6) {
    const ip = address.toLowerCase();
    // IPv4-mapped addresses smuggle a v4 address through a v6 check, and the
    // resolver hands them back in hex (::ffff:7f00:1), not the dotted form
    // (::ffff:127.0.0.1) they are usually written in. Handle both, and refuse
    // any mapped form that does not parse rather than letting it through.
    const mapped = ip.match(/^::ffff:(.+)$/);
    if (mapped) {
      const rest = mapped[1];
      if (rest.includes(".")) return isBlockedAddress(rest, 4);
      const groups = rest.split(":");
      if (groups.length !== 2) return true;
      const high = Number.parseInt(groups[0], 16);
      const low = Number.parseInt(groups[1], 16);
      if (!Number.isFinite(high) || !Number.isFinite(low)) return true;
      return isBlockedAddress(
        `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`,
        4
      );
    }
    if (ip === "::1" || ip === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true; // unique-local fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(ip)) return true; // link-local fe80::/10
    return false;
  }

  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // unparseable is not provably safe
  }
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== "https:") {
    throw new DocumentFetchError("Only https:// URLs can be fetched");
  }
  // URL.hostname keeps the brackets on an IPv6 literal ("[::1]"), which no
  // resolver accepts — so the lookup would fail and the address check below
  // would never run. Strip them, so a literal is judged by the same rules as
  // a resolved name rather than blocked by accident.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new DocumentFetchError(`Could not resolve ${host}`);
  }
  if (addresses.length === 0) {
    throw new DocumentFetchError(`Could not resolve ${host}`);
  }
  // Every address must be public: one private answer among several is enough
  // to make the request unsafe, since we do not choose which one is dialled.
  for (const { address, family } of addresses) {
    if (isBlockedAddress(address, family)) {
      throw new DocumentFetchError(
        `${host} resolves to a non-public address and will not be fetched`
      );
    }
  }
}

/**
 * Redirects are followed by hand so each hop can be re-validated. `fetch`'s
 * automatic following would validate only the first URL and then happily
 * chase a 302 into the private network.
 */
async function fetchFollowingRedirects(startUrl: string): Promise<Response> {
  let url = new URL(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url);
    const res = await fetch(url, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new DocumentFetchError(`Redirect with no location from ${url.host}`);
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) {
      throw new DocumentFetchError(`Source returned ${res.status} ${res.statusText}`);
    }
    return res;
  }
  throw new DocumentFetchError(`More than ${MAX_REDIRECTS} redirects`);
}

/** Aborts the transfer the moment it exceeds the cap, rather than after. */
function cappedStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > MAX_UPLOAD_BYTES) {
          controller.error(
            new DocumentFetchError(
              `Document exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit`
            )
          );
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );
}

/** Last path segment of the URL, as a starting point for the stored name. */
export function fileNameFromUrl(rawUrl: string, fallback: string): string {
  try {
    const name = decodeURIComponent(new URL(rawUrl).pathname.split("/").filter(Boolean).pop() ?? "");
    if (name.toLowerCase().endsWith(".pdf")) return name;
  } catch {
    /* fall through to the caller's title */
  }
  const base = fallback.trim().replace(/[\\/]+/g, "-") || "document";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

/**
 * Streams a PDF from `url` into Blob storage and returns it in the same shape
 * a browser upload produces, so the caller can start `ingestPdf` with it
 * exactly as `POST /api/upload` does.
 */
export async function downloadPdfToBlob(
  url: string,
  fileName: string
): Promise<UploadedFile> {
  const res = await fetchFollowingRedirects(url);

  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const looksLikePdf =
    ALLOWED_UPLOAD_CONTENT_TYPES.includes(contentType) ||
    // Plenty of document servers send octet-stream for a PDF. Accept it only
    // when the name agrees; anything else is refused rather than guessed at.
    (contentType === "application/octet-stream" && fileName.toLowerCase().endsWith(".pdf"));
  if (!looksLikePdf) {
    throw new DocumentFetchError(
      `Expected a PDF but the source returned "${contentType || "no content type"}"`
    );
  }

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    throw new DocumentFetchError(
      `Document is ${Math.round(declared / 1024 / 1024)} MB, over the ` +
        `${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit`
    );
  }
  if (!res.body) throw new DocumentFetchError("Source returned an empty response");

  const blob = await put(uploadPathname(fileName), cappedStream(res.body), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/pdf",
  });

  return {
    fileName,
    // Content-Length is advisory and absent on chunked responses; the uploads
    // row records 0 rather than a number that might be a lie.
    sizeBytes: Number.isFinite(declared) && declared > 0 ? declared : 0,
    url: blob.url,
    downloadUrl: blob.downloadUrl,
    pathname: blob.pathname,
  };
}
