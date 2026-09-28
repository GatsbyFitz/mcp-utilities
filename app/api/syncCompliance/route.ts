import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { Client, isFullPage } from "@notionhq/client";
import { embedMany } from "ai";
import { vectorIndex, escapeFilterValue } from "@/lib/vector";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@/lib/embedding";
import { replaceDocumentGraph } from "../upload/steps/extractGraph";
import {
  COMPLIANCE_KIND,
  COMPLIANCE_SOURCE_DOC,
  complianceId,
  type ComplianceAction,
} from "@/lib/compliance";
import { replaceActions } from "@/lib/complianceStore";
import {
  embeddableText,
  schemaProblems,
  toComplianceAction,
} from "@/lib/notionCompliance";

/**
 * POST /api/syncCompliance — pull the Compliance Tracker and index it.
 *
 * Notion is read here rather than by a build script so that pressing Sync is
 * the whole operation: no commit, no redeploy, and the tool is current with
 * the last press.
 *
 * Writes three stores, because each answers a question the others cannot:
 * Upstash so `search_docs` finds an action by what it was about, Neo4j so
 * `search_graph` walks who was penalised by whom for what, and Postgres so
 * `search_compliance` can return *every* matching row and add the fines up.
 */

/** Notion's page size ceiling. */
const PAGE_SIZE = 100;

/** Stop rather than loop forever if pagination never terminates. */
const MAX_PAGES = 50;

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const notionToken = process.env.NOTION_TOKEN;
  const sourceId = process.env.NOTION_COMPLIANCE_DATA_SOURCE_ID;
  if (!notionToken || !sourceId) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Set NOTION_TOKEN and NOTION_COMPLIANCE_DATA_SOURCE_ID before syncing the compliance tracker.",
      },
      { status: 500 }
    );
  }

  try {
    const actions = await fetchActions(notionToken, sourceId);

    if (actions.length === 0) {
      // Refuse to treat this as a successful empty sync. Wiping the table on
      // an empty read would answer "no, they have never been fined" — the
      // worst failure this data has, and indistinguishable from the truth.
      return NextResponse.json(
        {
          success: false,
          error:
            "Notion returned no usable rows. Nothing was changed — check the data source id and the integration's access.",
        },
        { status: 502 }
      );
    }

    await indexActions(actions);
    await writeGraphFor(actions);

    // Postgres last, deliberately. If embedding or the graph write fails, the
    // previous rows and their `synced_at` still stand, and the tool keeps
    // answering from the last good sync instead of from a half-written one.
    const { synced, deleted } = await replaceActions(actions);

    return NextResponse.json({ success: true, synced, deleted });
  } catch (error) {
    console.error("[syncCompliance] POST failed:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    // The schema mismatch is the one failure worth surfacing verbatim: it
    // names the property that changed, and no one can act on "sync failed".
    const isSchema = message.startsWith("Compliance Tracker schema");
    return NextResponse.json(
      { success: false, error: isSchema ? message : "Could not sync the compliance tracker" },
      { status: 500 }
    );
  }
}

/** Every page in the tracker, mapped and schema-checked. */
async function fetchActions(notionToken: string, sourceId: string): Promise<ComplianceAction[]> {
  const notion = new Client({ auth: notionToken });

  const actions: ComplianceAction[] = [];
  let cursor: string | undefined;
  let checked = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await notion.dataSources.query({
      data_source_id: sourceId,
      page_size: PAGE_SIZE,
      start_cursor: cursor,
    });

    for (const result of response.results) {
      // Partial results carry no properties; only full pages can be mapped.
      if (!isFullPage(result)) continue;

      // Checked once, on the first real page: a renamed or retyped property
      // affects every row identically, so this is one loud error rather than
      // a whole column quietly reading as null — which downstream would look
      // like "this action had no regulator" rather than "we failed to read
      // it". `Regulatory Body` is exactly the property that invites this.
      if (!checked) {
        const problems = schemaProblems(result);
        if (problems.length > 0) {
          throw new Error(`Compliance Tracker schema does not match: ${problems.join("; ")}`);
        }
        checked = true;
      }

      const action = toComplianceAction(result);
      if (action) actions.push(action);
    }

    if (!response.has_more || !response.next_cursor) break;
    cursor = response.next_cursor;
  }

  return actions;
}

/**
 * Upstash: one vector per action, in its own id namespace.
 *
 * `blobUrl` carries the regulator's own page, so `toCitation` links citations
 * there with no change to lib/citations.ts — the same trick figures used.
 */
async function indexActions(actions: ComplianceAction[]): Promise<void> {
  const { embeddings } = await embedMany({
    model: EMBEDDING_MODEL,
    values: actions.map((action) => `title: ${COMPLIANCE_SOURCE_DOC} | text: ${embeddableText(action)}`),
    providerOptions: {
      google: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType: "RETRIEVAL_DOCUMENT" },
    },
  });

  // Clear first so an action deleted in Notion does not survive as a vector
  // with nothing behind it. Scoped by `kind`, so chunks and figures are
  // untouched.
  await vectorIndex.delete({
    filter: `kind = '${escapeFilterValue(COMPLIANCE_KIND)}'`,
  });

  await vectorIndex.upsert(
    actions.map((action, i) => ({
      id: complianceId(action.pageId),
      vector: embeddings[i],
      metadata: {
        text: action.summary,
        title: COMPLIANCE_SOURCE_DOC,
        source: COMPLIANCE_SOURCE_DOC,
        kind: COMPLIANCE_KIND,
        blobUrl: action.sourceUrl ?? undefined,
        organisation: action.organisation ?? undefined,
        sector: action.sector ?? undefined,
        regulator: action.regulator ?? undefined,
        status: action.status ?? undefined,
        actionDate: action.actionDate ?? undefined,
        fine: action.fine ?? undefined,
        misconductTypes: action.misconductTypes,
      },
    }))
  );
}

/**
 * Neo4j: the same shape `search_graph` reads, built straight from the columns.
 *
 * No model call. `extractGraph` needs one because prose has to be read to find
 * its relationships, and that is where the free-form relation types come from
 * — the same obligation landing as MUST_NOTIFY on one chunk and SHALL_NOTIFY
 * on the next. These columns are already a closed vocabulary, so the edge
 * types are consistent by construction and cannot fragment.
 */
async function writeGraphFor(actions: ComplianceAction[]): Promise<void> {
  const entityTypes = new Map<string, string>();
  const relations: {
    source: string;
    relType: string;
    description: string;
    target: string;
    chunkId: string;
    sourceDoc: string;
  }[] = [];

  for (const action of actions) {
    const chunkId = complianceId(action.pageId);
    const detail = [
      action.summary,
      action.actionDate ? `Date: ${action.actionDate}` : null,
      action.fine !== null ? `Fine: ${action.fine}` : null,
      action.status ? `Status: ${action.status}` : null,
    ]
      .filter(Boolean)
      .join(". ");

    if (!action.organisation) continue;
    // The organisation list spans retailers, networks, generators and
    // wholesalers, so the entity type comes from the row's own Sector rather
    // than being assumed.
    entityTypes.set(action.organisation, action.sector ?? "organisation");

    if (action.regulator) {
      entityTypes.set(action.regulator, "regulator");
      relations.push({
        source: action.organisation,
        relType: "PENALISED_BY",
        description: detail,
        target: action.regulator,
        chunkId,
        sourceDoc: COMPLIANCE_SOURCE_DOC,
      });
    }

    for (const misconduct of action.misconductTypes) {
      entityTypes.set(misconduct, "misconduct");
      relations.push({
        source: action.organisation,
        relType: "COMMITTED",
        description: detail,
        target: misconduct,
        chunkId,
        sourceDoc: COMPLIANCE_SOURCE_DOC,
      });
    }
  }

  const names = [...entityTypes.keys()];
  if (names.length === 0) {
    await replaceDocumentGraph(COMPLIANCE_SOURCE_DOC, [], []);
    return;
  }

  // Same asymmetric convention as extractGraph: document-side here, query-side
  // in search_graph. Both must agree or the entity_names index stops matching.
  const { embeddings } = await embedMany({
    model: EMBEDDING_MODEL,
    values: names.map((name) => `entity: ${name} | type: ${entityTypes.get(name)}`),
    providerOptions: { google: { outputDimensionality: EMBEDDING_DIMENSIONS } },
  });

  await replaceDocumentGraph(
    COMPLIANCE_SOURCE_DOC,
    names.map((name, i) => ({
      name,
      type: entityTypes.get(name) ?? null,
      embedding: embeddings[i],
    })),
    relations
  );
}
