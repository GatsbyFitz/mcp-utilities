import type { Metadata } from "next";
import "./globals.css";
import { Geist, Geist_Mono } from "next/font/google";
import { baseURL } from "@/baseUrl";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MCP Apps Minimal Next.js",
  description: "Minimal MCP Apps starter with Next.js",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <IframeBootstrap baseUrl={baseURL} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

/**
 * Inline scripts that make a Next.js page work inside ChatGPT's, Cursor's, or Claude.ai's sandboxed
 * iframe. `assetPrefix` in next.config.ts handles script/style URLs, so no
 * `<base>` tag is needed (a `<base>` tag would break CesiumJS Worker URLs).
 */
function IframeBootstrap({ baseUrl }: { baseUrl: string }) {
  return (
    <>
      {/* Resolve relative URLs (/_next/static, /about, etc.) to the real server */}
      <script
        dangerouslySetInnerHTML={{
          __html: `window.__baseUrl=${JSON.stringify(baseUrl)};`,
        }}
      />
      <script
        dangerouslySetInnerHTML={{
          __html: `(${iframePatchFn.toString()})()`,
        }}
      />
    </>
  );
}

/**
 * Self-executing function injected as an inline `<script>`. It runs before
 * React hydrates and makes Next.js behave correctly inside an iframe whose
 * origin differs from the real server.
 *
 * NOTE: This function is serialised to a string via `.toString()` and
 * executed in a different context. TypeScript types here are purely for
 * readability — they are stripped when serialised.
 */
function iframePatchFn() {
  const baseUrl: string = window.__baseUrl;
  const htmlElement = document.documentElement;
  const isInIframe = window.self !== window.top;

  // 1. Prevent the host from mutating <html> attributes (causes hydration errors)
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && mutation.target === htmlElement) {
        const attr = mutation.attributeName;
        if (attr && attr !== "suppresshydrationwarning" && attr !== "lang") {
          htmlElement.removeAttribute(attr);
        }
      }
    }
  });
  observer.observe(htmlElement, { attributes: true, attributeOldValue: true });

  // 2. Patch history – the sandbox may reject cross-origin state changes.
  const origReplace = history.replaceState.bind(history);
  history.replaceState = function (
    _state: unknown,
    unused: string,
    url?: string | URL | null,
  ) {
    try {
      const u = new URL(String(url ?? ""), window.location.href);
      origReplace(null, unused, u.pathname + u.search + u.hash);
    } catch {
      /* SecurityError in sandboxed iframe */
    }
  };

  const origPush = history.pushState.bind(history);
  history.pushState = function (
    _state: unknown,
    unused: string,
    url?: string | URL | null,
  ) {
    try {
      const u = new URL(String(url ?? ""), window.location.href);
      origPush(null, unused, u.pathname + u.search + u.hash);
    } catch {
      /* SecurityError in sandboxed iframe */
    }
  };

  // 3. Intercept external link clicks → window.openai.openExternal()
  const appOrigin = new URL(baseUrl).origin;
  window.addEventListener(
    "click",
    (e: MouseEvent) => {
      const a = (e.target as HTMLElement)?.closest?.("a");
      if (!a?.href) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin && url.origin !== appOrigin) {
        try {
          (window as any).openai?.openExternal?.({ href: a.href });
          e.preventDefault();
        } catch {
          /* noop */
        }
      }
    },
    true,
  );

  // 4. Patch fetch so RSC / data payloads go to the real server
  if (isInIframe && window.location.origin !== appOrigin) {
    const originalFetch = window.fetch.bind(window);

    window.fetch = function patchedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      let url: URL;
      if (typeof input === "string" || input instanceof URL) {
        url = new URL(String(input), window.location.href);
      } else {
        url = new URL(input.url, window.location.href);
      }

      if (url.origin === appOrigin || url.origin === window.location.origin) {
        const rewritten = new URL(baseUrl);
        rewritten.pathname = url.pathname;
        rewritten.search = url.search;
        rewritten.hash = url.hash;

        const newInput =
          typeof input === "string" || input instanceof URL
            ? rewritten.toString()
            : new Request(rewritten.toString(), input);

        return originalFetch(newInput, { ...init, mode: "cors" });
      }

      return originalFetch(input, init);
    } as typeof fetch;
  }
}