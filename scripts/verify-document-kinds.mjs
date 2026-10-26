/**
 * Will the fetcher accept what these servers actually send?
 *
 *   pnpm verify:document-kinds
 *
 * `downloadToBlob` checks a source's declared content type before storing
 * anything, which is right: a workbook admitted as a PDF fails much later and
 * much less clearly. But the check is a string comparison against a hand-written
 * allowlist, and that is a thing that can be quietly wrong for a year.
 *
 * It was. `ALLOWED_SPREADSHEET_CONTENT_TYPES` holds the canonical IANA spelling
 * `application/vnd.ms-excel.sheet.macroEnabled.12`; the AER's server sends
 * `…macroenabled.12`, all lower case; and the incoming header was lowercased
 * before being compared against the mixed-case list. So **every `.xlsm`
 * workbook was refused**, while the code carried a comment saying `.xlsm` is
 * supported *because the AER ships it*. Nothing failed until a real fetch ran,
 * because nothing had ever fetched one.
 *
 * So the strings below are not invented. Each is a header observed from the
 * real host, and this check exists to keep the allowlist honest about them.
 *
 * Offline, no credentials: the matching rule is pure.
 */
import {
  PDF_KIND,
  SPREADSHEET_KIND,
  contentTypeAllowed,
  declaredContentType,
  fileNameFromUrl,
} from "@/lib/fetchDocument";

let failed = false;
const fail = (message, detail) => {
  failed = true;
  console.log(`FAIL  ${message}${detail ? `\n      ${detail}` : ""}`);
};
const pass = (message) => console.log(`ok    ${message}`);
const check = (message, ok, detail) => (ok ? pass(message) : fail(message, detail));

/** What a source really sent, header and all, as `downloadToBlob` sees it. */
const asSent = (header, kind, fileName) =>
  contentTypeAllowed(kind, declaredContentType(header), fileName);

console.log("Headers observed from aer.gov.au:");
{
  // Captured from a Sydney sandbox fetching the Q4 2023-24 Schedule 2 workbook.
  // This exact string is what the failing ingest reported back.
  check(
    "the macro-enabled type the AER actually sends is accepted",
    asSent(
      "application/vnd.ms-excel.sheet.macroenabled.12",
      SPREADSHEET_KIND,
      "schedule-2.xlsm"
    ),
    "This is the regression: lower-case `macroenabled` against a canonical `macroEnabled` allowlist."
  );
  check(
    "and so is the canonical spelling, which is what Blob is told to expect",
    asSent(
      "application/vnd.ms-excel.sheet.macroEnabled.12",
      SPREADSHEET_KIND,
      "schedule-2.xlsm"
    )
  );
  check(
    "a plain .xlsx type is accepted",
    asSent(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      SPREADSHEET_KIND,
      "schedule-2.xlsx"
    )
  );
  check(
    "a charset parameter does not defeat the match",
    asSent(
      "application/vnd.ms-excel.sheet.macroenabled.12; charset=UTF-8",
      SPREADSHEET_KIND,
      "schedule-2.xlsm"
    )
  );
  check(
    "upper case does not either — RFC 2045 says media types are case-insensitive",
    asSent(
      "APPLICATION/VND.MS-EXCEL.SHEET.MACROENABLED.12",
      SPREADSHEET_KIND,
      "schedule-2.xlsm"
    )
  );
}

console.log("\nThe octet-stream escape hatch stays narrow:");
{
  check(
    "octet-stream is accepted when the file name agrees",
    asSent("application/octet-stream", SPREADSHEET_KIND, "schedule-2.xlsm")
  );
  check(
    "and when it is an .xlsx",
    asSent("application/octet-stream", SPREADSHEET_KIND, "schedule-2.xlsx")
  );
  check(
    "but refused when the name does not",
    !asSent("application/octet-stream", SPREADSHEET_KIND, "schedule-2.pdf")
  );
  check(
    "a percent-encoded name still resolves to a usable extension",
    asSent(
      "application/octet-stream",
      SPREADSHEET_KIND,
      fileNameFromUrl(
        "https://www.aer.gov.au/system/files/2024-12/Schedule%202%20-%20Quarter%204%202023%E2%80%9324%20retail%20performance%20data.xlsm",
        "fallback",
        SPREADSHEET_KIND
      )
    ),
    `Derived name: ${fileNameFromUrl(
      "https://www.aer.gov.au/system/files/2024-12/Schedule%202%20-%20Quarter%204%202023%E2%80%9324%20retail%20performance%20data.xlsm",
      "fallback",
      SPREADSHEET_KIND
    )}`
  );
}

console.log("\nThe two kinds stay separate, which is the point of having two:");
{
  check("a PDF type is accepted by the PDF kind", asSent("application/pdf", PDF_KIND, "doc.pdf"));
  check(
    "a PDF type is refused by the spreadsheet kind",
    !asSent("application/pdf", SPREADSHEET_KIND, "schedule-2.xlsm")
  );
  check(
    "a spreadsheet type is refused by the PDF kind",
    !asSent(
      "application/vnd.ms-excel.sheet.macroenabled.12",
      PDF_KIND,
      "schedule-2.xlsm"
    ),
    "Widening the PDF list would let a workbook through and fail it inside createMarkdown instead."
  );
  check(
    "an HTML error page pretending to be a download is refused",
    !asSent("text/html; charset=utf-8", SPREADSHEET_KIND, "schedule-2.xlsm")
  );
  check(
    "no content type at all is refused",
    !asSent(null, SPREADSHEET_KIND, "schedule-2.xlsm")
  );
  check("an empty content type is refused", !asSent("", SPREADSHEET_KIND, "schedule-2.xlsm"));
}

console.log(
  failed ? "\nSome document-kind checks FAILED." : "\nAll document-kind checks passed."
);
process.exit(failed ? 1 : 0);
