import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

// Only the upload page itself is gated — API routes are untouched, matching
// every other route's existing CORS-only behavior.
const PROTECTED_PATHS = ["/"];

export async function middleware(request: NextRequest) {
  if (request.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 });
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,DELETE,OPTIONS",
    );
    response.headers.set("Access-Control-Allow-Headers", "*");
    return response;
  }

  if (PROTECTED_PATHS.includes(request.nextUrl.pathname)) {
    const token = await getToken({ req: request });
    if (!token) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("callbackUrl", request.nextUrl.pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next({
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export const config = {
  matcher: ["/((?!\\.well-known/workflow/).*)"],
};