import type { ComplianceAction } from "@/lib/compliance";

// ---------------------------------------------------------------------------
// Notion page → ComplianceAction
// ---------------------------------------------------------------------------
// Kept apart from the Notion client so the mapping can be tested against
// captured page fixtures with no network and no token. The mapping is where
// this integration actually breaks: a renamed or retyped Notion property does
// not throw, it just yields null, and a null reads downstream as a real
// absence — "no fine" rather than "we failed to read the fine".
//
// Property names verified against the live data source rather than taken from
// a screenshot, which is how `Regulatory Body` was caught: it renders as
// "Regula…" in a narrow column and would have been read as `Regulator`,
// silently leaving every row's regulator null.

/** Exactly as they are spelled in the Compliance Tracker data source. */
export const PROPERTY = {
  summary: "Summary",
  organisation: "Organisation",
  sector: "Sector",
  date: "Date",
  regulator: "Regulatory Body",
  status: "Status",
  fine: "Fine",
  source: "Source",
  misconductTypes: "Misconduct Type",
} as const;

/** Property names that must exist, and the Notion type each must have. */
const REQUIRED_TYPES: Record<string, string> = {
  [PROPERTY.summary]: "title",
  [PROPERTY.organisation]: "select",
  [PROPERTY.sector]: "select",
  [PROPERTY.date]: "date",
  [PROPERTY.regulator]: "select",
  [PROPERTY.status]: "select",
  [PROPERTY.fine]: "number",
  [PROPERTY.source]: "url",
  [PROPERTY.misconductTypes]: "multi_select",
};

type Properties = Record<string, unknown>;

function propertyOf(page: unknown): Properties | null {
  const properties = (page as { properties?: unknown } | null)?.properties;
  return properties && typeof properties === "object" ? (properties as Properties) : null;
}

function typeOf(value: unknown): string | null {
  const type = (value as { type?: unknown } | null)?.type;
  return typeof type === "string" ? type : null;
}

/**
 * Checks the schema before mapping anything.
 *
 * Deliberately a hard failure rather than a per-row fallback: a renamed
 * property affects every row identically, so the choice is between one loud
 * error and a whole table quietly losing a column. Returns the mismatches so
 * the message can name them.
 */
export function schemaProblems(page: unknown): string[] {
  const properties = propertyOf(page);
  if (!properties) return ["the page has no properties at all"];

  const problems: string[] = [];
  for (const [name, expected] of Object.entries(REQUIRED_TYPES)) {
    if (!(name in properties)) {
      problems.push(`missing property "${name}"`);
      continue;
    }
    const actual = typeOf(properties[name]);
    if (actual !== expected) {
      problems.push(`property "${name}" is ${actual ?? "untyped"}, expected ${expected}`);
    }
  }
  return problems;
}

function plainText(value: unknown): string {
  const parts = (value as { title?: unknown; rich_text?: unknown } | null) ?? {};
  const items = Array.isArray(parts.title)
    ? parts.title
    : Array.isArray(parts.rich_text)
      ? parts.rich_text
      : [];
  return items
    .map((item) => (item as { plain_text?: unknown }).plain_text)
    .filter((text): text is string => typeof text === "string")
    .join("")
    .trim();
}

function selectName(value: unknown): string | null {
  const name = (value as { select?: { name?: unknown } | null } | null)?.select?.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function multiSelectNames(value: unknown): string[] {
  const options = (value as { multi_select?: unknown } | null)?.multi_select;
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => (option as { name?: unknown }).name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

function numberValue(value: unknown): number | null {
  const number = (value as { number?: unknown } | null)?.number;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function urlValue(value: unknown): string | null {
  const url = (value as { url?: unknown } | null)?.url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/**
 * The date the action happened.
 *
 * Notion's date property can carry a range. The start is what an enforcement
 * action is dated by, and taking it keeps a range from being dropped entirely
 * — which a naive read of `date.date` as a string would do.
 */
function startDate(value: unknown): string | null {
  const start = (value as { date?: { start?: unknown } | null } | null)?.date?.start;
  if (typeof start !== "string" || start.length === 0) return null;
  // Notion returns a date or a datetime; the table column is a DATE.
  return start.slice(0, 10);
}

/** One Notion page mapped, or null when it carries no summary to identify it by. */
export function toComplianceAction(page: unknown): ComplianceAction | null {
  const properties = propertyOf(page);
  const pageId = (page as { id?: unknown } | null)?.id;
  if (!properties || typeof pageId !== "string") return null;

  const summary = plainText(properties[PROPERTY.summary]);
  // An untitled row is a blank line in Notion, not an enforcement action.
  // Indexing it would put an empty result into every broad search.
  if (!summary) return null;

  return {
    pageId,
    summary,
    organisation: selectName(properties[PROPERTY.organisation]),
    sector: selectName(properties[PROPERTY.sector]),
    actionDate: startDate(properties[PROPERTY.date]),
    regulator: selectName(properties[PROPERTY.regulator]),
    status: selectName(properties[PROPERTY.status]),
    fine: numberValue(properties[PROPERTY.fine]),
    sourceUrl: urlValue(properties[PROPERTY.source]),
    misconductTypes: multiSelectNames(properties[PROPERTY.misconductTypes]),
  };
}

/**
 * What gets embedded for an action.
 *
 * The summary alone would match "Centrepay overcharging" but not "ESC family
 * violence ruling" — the fields carry as much of the question as the prose
 * does. They are folded in here rather than at the call site so the text that
 * is embedded and the text stored as the excerpt cannot drift apart.
 */
export function embeddableText(action: ComplianceAction): string {
  const parts = [
    action.summary,
    action.organisation,
    action.sector,
    action.regulator,
    action.status,
    action.misconductTypes.join(", "),
    action.actionDate,
    action.fine !== null ? `fine ${action.fine}` : null,
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" | ");
}
