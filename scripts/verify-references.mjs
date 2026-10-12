// The parts of live-reference reading that must not be wrong.
//
// Two of them matter more than the rest:
//
//  1. A page that renders in the browser returns 200 with an empty shell. If
//     that is passed off as content, a model reports "the documentation does
//     not cover that" — indistinguishable from a true answer, and worse than
//     an error. The AEMO developer portal is Azure API Management, which is
//     exactly this kind of site, so this is a live risk and not a hypothetical.
//  2. The tool is keyed by name, never by URL. A name that is not in the list
//     must resolve to nothing at all.
//
// Pure: no network, no model, no database.
//
// Run: pnpm verify:references
import {
  REFERENCES,
  emptyShellMessage,
  htmlToText,
  looksLikeEmptyShell,
  referenceByName,
  renderReferenceList,
} from "@/lib/references";

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n    ${detail}` : ""}`); }
};

console.log("Pulling text out of a documentation page:");
{
  const html = `
    <html><head><title>API</title>
      <style>.x{color:red}</style>
      <script>var a = "GET /fake/endpoint";</script>
    </head>
    <body>
      <h1>NEM Dispatch Bidding</h1>
      <p>Submit energy, FCAS &amp; MNSP bids.</p>
      <table><tr><td>GET</td><td>/v1/bids/{bidId}</td></tr></table>
      <div>Requires a &lt;client certificate&gt;.</div>
    </body></html>`;
  const text = htmlToText(html);

  check("keeps the heading", text.includes("NEM Dispatch Bidding"), text);
  check("keeps the endpoint path", text.includes("/v1/bids/{bidId}"), text);
  check("decodes entities", text.includes("FCAS & MNSP") && text.includes("<client certificate>"), text);
  // Script bodies read like content and are not: a fake endpoint inside a
  // bundle must never reach a model as documentation.
  check("drops script contents, including anything endpoint-shaped",
    !text.includes("/fake/endpoint"), text);
  check("drops style contents", !text.includes("color:red"), text);
  check("does not run rows together",
    text.split("\n").some((l) => l.includes("/v1/bids/{bidId}")), JSON.stringify(text));
}

console.log("Telling a shell apart from a page:");
{
  // What Azure API Management's portal serves before its bundle runs.
  const shell =
    `<html><head><title>AEMO APIs</title>` +
    `<script src="/bundle.js"></script>`.repeat(40) +
    `</head><body><div id="root"></div></body></html>`;
  check("a JavaScript shell is recognised",
    looksLikeEmptyShell(shell, htmlToText(shell)), JSON.stringify(htmlToText(shell)));

  const real =
    `<html><body><h1>NEM Dispatch Bidding</h1>` +
    `<p>${"Submit energy, FCAS and MNSP bids and offers to AEMO. ".repeat(40)}</p>` +
    `</body></html>`;
  check("a real page is not", !looksLikeEmptyShell(real, htmlToText(real)));

  // A short page is short, not broken — the ratio test must not fire on one.
  const tiny = `<html><body><p>Service unavailable.</p></body></html>`;
  check("a genuinely short page is not called a shell",
    !looksLikeEmptyShell(tiny, htmlToText(tiny)));

  const message = emptyShellMessage(REFERENCES[0]);
  check("the shell message refuses to be read as 'no such documentation'",
    /not "the documentation says nothing"/i.test(message) && /nothing was read/i.test(message),
    message);
  check("the shell message says what to do instead",
    /OpenAPI/.test(message) && message.includes(REFERENCES[0].url), message);
}

console.log("Keyed by name, never by URL:");
{
  check("a known name resolves", referenceByName("aemo-api-docs")?.url.startsWith("https://"));
  check("case and padding do not matter", referenceByName("  AEMO-API-DOCS ")?.name === "aemo-api-docs");
  check("an unknown name resolves to nothing", referenceByName("not-a-reference") === undefined);
  // The attack this shape exists to prevent: a URL must never be accepted as
  // a name and dereferenced.
  check("a URL is not a name", referenceByName("https://evil.example/x") === undefined);
  check("every reference is https",
    REFERENCES.every((r) => r.url.startsWith("https://")), JSON.stringify(REFERENCES.map((r) => r.url)));
  check("names are unique", new Set(REFERENCES.map((r) => r.name)).size === REFERENCES.length);
  check("names are lower-case, so a lookup can normalise",
    REFERENCES.every((r) => r.name === r.name.toLowerCase()));
}

console.log("The catalogue the model is shown:");
{
  const list = renderReferenceList();
  check("every reference is listed", REFERENCES.every((r) => list.includes(r.name)), list);
  check("each entry says when to use it", REFERENCES.every((r) => list.includes(r.description)));
}

console.log(failures === 0 ? "\nAll reference checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
