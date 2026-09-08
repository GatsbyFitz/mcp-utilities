import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

// Page routes gated by redirecting to the login screen.
const PROTECTED_PAGES = ["/", "/graph"];

/**
 * The only API paths reachable without a session. NextAuth's own endpoints
 * have to be, or there is no way to log in and obtain one.
 *
 * `/mcp` is not under `/api` and so is not covered here — it stays open
 * deliberately, since external MCP clients connect to it.
 */
const PUBLIC_API_PREFIXES = ["/api/auth/"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function middleware(request: NextRequest) {
  if (request.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 });
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      response.headers.set(key, value);
    }
    return response;
  }

  const { pathname } = request.nextUrl;

  // Deny by default across the API surface. Every route also checks its own
  // session, but this is what makes a *newly added* route protected because
  // it exists rather than because someone remembered to gate it — which is
  // how deleteDocument, reembed and returnKnowledgeBase came to be open.
  if (
    pathname.startsWith("/api/") &&
    !PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  ) {
    const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
    if (!token) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401, headers: CORS_HEADERS }
      );
    }
  }

  if (PROTECTED_PAGES.includes(pathname)) {
    const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
    if (!token) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next({ headers: CORS_HEADERS });
}

export const config = {
  matcher: ["/((?!\\.well-known/workflow/).*)"],
};
