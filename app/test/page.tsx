"use client";

import Link from "next/link";
import { useMcpApp } from "@/app/hooks/use-mcp-app";

export default function Home() {
  const { toolInput, toolResult, connected } = useMcpApp();
  const data = (toolResult ?? toolInput) as Record<string, unknown> | null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-zinc-950">
      <main className="flex w-full max-w-xl flex-col gap-8 px-8 py-16">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          MCP Apps Starter
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          A minimal Next.js starter for building{" "}
          <a
            href="https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt"
            className="font-medium text-zinc-900 underline underline-offset-2 dark:text-zinc-100"
          >
            MCP Apps
          </a>{" "}
          that render inside ChatGPT, Cursor, or Claude.ai.
        </p>

        {connected && (
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
              Tool output
            </p>
            <pre className="mt-2 overflow-auto text-sm text-zinc-800 dark:text-zinc-200">
              {data ? JSON.stringify(data, null, 2) : "Waiting for tool call..."}
            </pre>
          </div>
        )}

        <nav className="flex flex-col gap-3">
          <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            Pages
          </p>
          <Link
            href="/about"
            prefetch={false}
            className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            About &rarr;
          </Link>
          <Link
            href="/counter"
            prefetch={false}
            className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            Counter demo &rarr;
          </Link>
        </nav>

        <div className="flex flex-col gap-1 text-xs text-zinc-400 dark:text-zinc-500">
          <p>MCP server: <code>/mcp</code></p>
          <p>
            {connected
              ? "Connected to MCP host"
              : "Not connected (open in ChatGPT, Cursor, or Claude.ai to connect)"}
          </p>
        </div>
      </main>
    </div>
  );
}