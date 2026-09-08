import { Index } from "@upstash/vector";

export const vectorIndex = new Index({
  url: process.env.UPSTASH_VECTOR_REST_URL!,
  token: process.env.UPSTASH_VECTOR_REST_TOKEN!,
});
/**
 * Escapes single quotes for Upstash's SQL-like metadata filter syntax.
 * `source` is the original uploaded file name, which is user-controlled, so
 * every filter built from it goes through here.
 */
export function escapeFilterValue(value: string): string {
  return value.replace(/'/g, "''");
}
