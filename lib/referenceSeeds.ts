import type { ReferenceSource } from "@/lib/references";

// ---------------------------------------------------------------------------
// Starting content for reference_sources
// ---------------------------------------------------------------------------
// Seed content, not a source of truth. The table is authoritative: these rows
// are a starting set so a fresh deployment is useful before anyone has typed a
// summary, and they can be edited or deleted afterwards like any other row.
// `find_reference` never reads this file.
//
// Every entry here must point at a URL that exists. A reference pointing at a
// 404 is worse than a missing one: the caller fetches it, finds nothing, and
// reports that the documentation does not cover the question — which is
// indistinguishable from a true answer. So an API gets a row only once its own
// URL is known, and the three AEMO APIs that have no distinct URL yet are
// deliberately absent rather than guessed at.
//
// On granularity: one row per page a person would actually open. The two below
// answer different questions on purpose — the catalogue answers "does an API
// exist for this", the portal answers "how do I get access" — because
// descriptors compete with each other, and a vague one absorbs traffic that
// belonged to a specific one.

export type ReferenceSeed = Omit<ReferenceSource, "indexedAt">;

export const REFERENCE_SEEDS: readonly ReferenceSeed[] = [
  {
    name: "aemo-api-catalogue",
    url: "https://dev.aemo.com.au/api-docs",
    title: "AEMO Developer Portal — API catalogue",
    summary:
      "The index of the APIs AEMO publishes for its market systems: what each " +
      "one is for and which market process it belongs to, including NEM " +
      "Dispatch Bidding (energy, FCAS and MNSP bids and offers), DER " +
      "Registration for NSPs, and Settlement Direct. Use it to find out " +
      "whether an API exists for a given task and what it is called, before " +
      "looking up how to call it. It is a catalogue, so it lists and describes " +
      "the APIs rather than documenting their endpoints.",
    // These carry the sparse half of the index, which is what matches an
    // opaque token a question will use verbatim. Listing the API names here is
    // what lets one catalogue row serve questions about any of them.
    keyTerms: [
      "NEM",
      "WEM",
      "API catalogue",
      "NEM Dispatch Bidding",
      "FCAS",
      "MNSP",
      "DER Registration",
      "DER register",
      "Settlement Direct",
      "AEMO APIs",
      "market systems",
    ],
  },
  {
    name: "aemo-developer-portal",
    url: "https://dev.aemo.com.au",
    title: "AEMO Developer Portal — access and accreditation",
    summary:
      "How to get access to AEMO's APIs rather than how to call them: signing " +
      "up for an API key, the accreditation steps between reading the " +
      "documentation and going live (forms and tests), and moving from the " +
      "Pre-Production test system to Production. Also where the portal's " +
      "support routes live. Covers what a participant must do before any API " +
      "call will be accepted.",
    keyTerms: [
      "accreditation",
      "API key",
      "pre-production",
      "production",
      "sign up",
      "DigiCert",
      "client certificate",
      "mutual TLS",
      "Azure API Management",
      "participant access",
      "go live",
    ],
  },
];
