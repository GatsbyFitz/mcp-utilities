// Can a model read a REAL AER sheet well enough for the shipped extractor?
//
// `verify:aer` proves `extractRows` is correct given a hand-written mapping.
// It cannot prove the mapping a model actually returns is that mapping, and
// that gap is where the worst failure lives: the columns of these workbooks
// are quarters, and a model that reports one header row of metrics makes five
// "Customer numbers" columns collapse onto one key — leaving a real number
// from the wrong quarter under a correct-looking label.
//
// So this runs the whole inference path against the real thing: the prompt
// `parseSchedule.ts` sends, a sheet captured from the live Schedule 2
// Q4 2023-24 workbook, and the shipped `mappingProblems`/`extractRows`. The
// last assertions read five values back against the spreadsheet cells they
// came from, which is the only check that catches a mapping that is
// confidently wrong rather than obviously wrong.
//
// Needs `ANTHROPIC_API_KEY` and skips cleanly without one, the same shape as
// stage B of `verify:multimodal`. It calls Anthropic directly rather than
// through the gateway — one fewer moving part for a check that is about the
// prompt — but on `SHEET_MAPPING_MODEL` itself rather than a model id typed in
// here, because a check against a model production does not use proves nothing
// about production.
//
// Run: pnpm verify:aer-inference
import fs from "node:fs";
import path from "node:path";
import { extractRows, mappingProblems } from "@/lib/sheetMapping";
import { canonicalMetric } from "@/lib/aerPerformance";
import { SHEET_MAPPING_MODEL, isAnthropicModel } from "@/lib/models";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.log("ANTHROPIC_API_KEY not set — skipping (this check needs a live model).");
  process.exit(0);
}

// The gateway slug carries a provider prefix the Anthropic API does not take.
// Refused rather than guessed: if inference moves to another provider, this
// check cannot speak for it and should say so instead of testing a model
// nothing uses.
if (!isAnthropicModel(SHEET_MAPPING_MODEL)) {
  console.error(
    `SHEET_MAPPING_MODEL is ${SHEET_MAPPING_MODEL}, which this check cannot call directly. ` +
      `Point it at that provider or run the inference through the gateway.`
  );
  process.exit(1);
}
const model = SHEET_MAPPING_MODEL.replace(/^anthropic\//, "");
console.log(`Inferring with ${model} (SHEET_MAPPING_MODEL).`);

// The prompt is read out of the step rather than copied, so this cannot drift
// from what production sends. Only the TypeScript signature is rewritten.
const stepSource = fs.readFileSync(
  path.join(process.cwd(), "app/api/upload/steps/parseSchedule.ts"),
  "utf8"
);
const from = stepSource.indexOf("function prompt(");
const body = stepSource
  .slice(from, stepSource.indexOf("\n}\n", from) + 3)
  .replace(/^function prompt\([^)]*\): string \{/, "function prompt(schedule, preview, known) {")
  .replace("SCHEDULE_SUBJECTS[schedule]", "SUBJECTS[schedule]");
const SUBJECTS = {
  2: "customer numbers, switching, contracts, meter installations and tariffs",
  3: "complaints, debt, Centrepay, payment plans, concessions and disconnections",
  4: "hardship customer numbers and hardship debt",
};
const prompt = new Function("SUBJECTS", `${body}; return prompt;`)(SUBJECTS);

const fixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "scripts/fixtures/aer-schedule2-res-elec.json"), "utf8")
);
const grid = fixture.grid;
const maxRow = Math.max(...Object.keys(grid).map((k) => Number(k.match(/\d+/)[0])));
const sheet = {
  name: fixture.name,
  rowCount: maxRow,
  cell: (row, col) => (grid[`${col}${row}`] !== undefined ? grid[`${col}${row}`] : null),
};

const L = (n) => { let s=""; while(n>0){const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=Math.floor((n-m-1)/26);} return s; };
const lines = [];
for (let row = 1; row <= Math.min(sheet.rowCount, 30); row++) {
  const cells = [];
  for (let c = 1; c <= 40; c++) {
    const v = sheet.cell(row, L(c));
    if (v !== null && String(v).trim()) cells.push(`${L(c)}: ${String(v).trim().slice(0, 80)}`);
  }
  if (cells.length) lines.push(`row ${row} | ${cells.join(" | ")}`);
}

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n    ${detail}` : ""}`); }
};

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  body: JSON.stringify({
    model,
    max_tokens: 8000,
    messages: [{
      role: "user",
      content:
        prompt(2, { name: sheet.name, rowCount: sheet.rowCount, text: lines.join("\n") }, []) +
        '\n\nReturn ONLY JSON: {"isData":bool,"metricRow":int,"periodRow":int,"retailerColumn":str,' +
        '"jurisdictionColumn":str,"fuelColumn":str,"customerTypeColumn":str,"jurisdictionCell":str,' +
        '"fuelCell":str,"customerTypeCell":str,"metrics":[{"column":str,"header":str,"matchesKnownMetric":str}],' +
        '"definitions":[{"term":str,"definition":str}],"notes":str}',
    }],
  }),
});
if (!res.ok) {
  console.error(`model call failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}
const text = (await res.json()).content.filter((b) => b.type === "text").map((b) => b.text).join("");
const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));

console.log("The mapping a model returns for a real sheet:");
check("the sheet is recognised as data", j.isData === true);
check("the measure row is found", j.metricRow === 4, `got ${j.metricRow}, expected 4`);
// The one that matters. Reported as 0, five quarters collapse into one key.
check("the PERIOD row is found — the columns are quarters", j.periodRow === 5,
  `got ${j.periodRow}, expected 5`);
check("the retailer column is found", (j.retailerColumn || "").toUpperCase() === "A", j.retailerColumn);
// Stated above the table, not in columns. Read as columns, every row loses them.
check("fuel is read from its cell", (j.fuelCell || "").toUpperCase() === "B3", j.fuelCell);
check("customer segment is read from its cell", (j.customerTypeCell || "").toUpperCase() === "C3", j.customerTypeCell);
check("jurisdiction is read from its cell", (j.jurisdictionCell || "").toUpperCase() === "A4", j.jurisdictionCell);
check("and none of them is mistaken for a column",
  !j.fuelColumn && !j.customerTypeColumn && !j.jurisdictionColumn,
  `${j.fuelColumn} / ${j.customerTypeColumn} / ${j.jurisdictionColumn}`);
check("every measure column is listed, not deduplicated by name",
  j.metrics.length === 13, `got ${j.metrics.length}, expected 13`);

const mapping = {
  metricRow: j.metricRow,
  periodRow: j.periodRow,
  dimensions: {
    retailer: (j.retailerColumn || "").toUpperCase(),
    jurisdiction: (j.jurisdictionColumn || "").toUpperCase() || undefined,
    fuel: (j.fuelColumn || "").toUpperCase() || undefined,
    customerType: (j.customerTypeColumn || "").toUpperCase() || undefined,
  },
  sheetDimensions: {
    jurisdiction: (j.jurisdictionCell || "").toUpperCase() || undefined,
    fuel: (j.fuelCell || "").toUpperCase() || undefined,
    customerType: (j.customerTypeCell || "").toUpperCase() || undefined,
  },
  metrics: (j.metrics || []).map((m) => ({
    column: String(m.column).toUpperCase(),
    raw: m.header,
    metric: (m.matchesKnownMetric || "").trim() || canonicalMetric(m.header),
  })),
};

console.log("What the shipped code does with it:");
const problems = mappingProblems(sheet, mapping);
check("the validator accepts it", problems.length === 0, problems.join(" | "));

if (problems.length === 0) {
  const rows = extractRows(sheet, mapping);
  const periods = [...new Set(rows.map((r) => r.periodLabel))].sort();
  const metrics = [...new Set(rows.map((r) => r.metric))];
  check("five quarters come out of one workbook", periods.length === 5, JSON.stringify(periods));
  check("each is normalised to the stored form", periods.every((p) => /^\d{4}-\d{2} Q[1-4]$/.test(p)),
    JSON.stringify(periods));
  check("thirteen columns fold into three metrics", metrics.length === 3, JSON.stringify(metrics));
  check("the sheet's fuel reaches every row", rows.every((r) => r.fuel === "electricity"));
  check("so does its segment", rows.every((r) => r.customerType === "residential"));

  // The spot check. A wrong mapping produces thousands of plausible rows, and
  // this is the only assertion that notices.
  const customerNumbers = metrics.find((m) => m.includes("customer_numbers"));
  const expected = {
    "2022-23 Q4": [1518827, "B8"],
    "2023-24 Q1": [1499977, "C8"],
    "2023-24 Q2": [1493588, "D8"],
    "2023-24 Q3": [1496817, "E8"],
    "2023-24 Q4": [1509284, "F8"],
  };
  for (const [period, [want, cell]] of Object.entries(expected)) {
    const got = rows.find(
      (r) => r.retailer === "agl" && r.metric === customerNumbers && r.periodLabel === period
    );
    check(`AGL ${period} is the number in ${cell}`,
      got?.value === want && got?.cellRef === cell,
      `want ${want} from ${cell}, got ${got?.value ?? "(missing)"} from ${got?.cellRef ?? "-"}`);
  }
}

console.log(failures === 0 ? "\nAll AER inference checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
