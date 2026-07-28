import neo4j, { type Driver, type Session, type ManagedTransaction } from "neo4j-driver";

// ---------------------------------------------------------------------------
// Driver singleton
// ---------------------------------------------------------------------------
// Next.js hot-reload re-evaluates modules in dev; without the globalThis
// guard, every save stacks another driver (and its connection pool) until
// Aura's connection limit trips. Same pattern as a Prisma singleton.

const globalForNeo4j = globalThis as unknown as { neo4jDriver?: Driver };

function createDriver(): Driver {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USERNAME ?? process.env.NEO4J_USER;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    throw new Error(
      "Missing Neo4j env vars: NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD"
    );
  }
  return neo4j.driver(uri, neo4j.auth.basic(user, password), {
    // Return Cypher integers as JS numbers instead of Integer objects,
    // so callers never need .toNumber(). Safe here: nothing in this graph
    // (hop counts, scores) approaches 2^53.
    disableLosslessIntegers: true,
    // Aura closes idle connections around the 60s mark; keeping the pool's
    // max lifetime under Aura's threshold avoids "connection reset" noise
    // on warm serverless invocations.
    maxConnectionLifetime: 30 * 60 * 1000,
    connectionAcquisitionTimeout: 10 * 1000,
  });
}

// Built on first query, not at import time: this module is pulled into the
// workflow step route, and a config error thrown during module evaluation
// takes down every step in the route, not just the graph ones.
export function getGraphDriver(): Driver {
  const existing = globalForNeo4j.neo4jDriver;
  if (existing) return existing;
  const driver = createDriver();
  if (process.env.NODE_ENV !== "production") {
    globalForNeo4j.neo4jDriver = driver;
  }
  return driver;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------
// Sessions are cheap but must be closed, or connections leak across warm
// invocations. These helpers make the try/finally impossible to forget and
// give call sites a one-liner.

export async function withSession<T>(
  fn: (session: Session) => Promise<T>
): Promise<T> {
  const session = getGraphDriver().session({
    database: process.env.NEO4J_DATABASE,
  });
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

/** Read transaction with automatic retry on transient failures. */
export async function readGraph<T>(
  fn: (tx: ManagedTransaction) => Promise<T>
): Promise<T> {
  return withSession((s) => s.executeRead(fn));
}

/** Write transaction with automatic retry on transient failures. */
export async function writeGraph<T>(
  fn: (tx: ManagedTransaction) => Promise<T>
): Promise<T> {
  return withSession((s) => s.executeWrite(fn));
}