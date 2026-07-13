"use client"

import { useMcpApp } from "@/app/hooks/use-mcp-app";

export default function Page() {
  // Use the hook to establish the bridge, but don't show the data
  useMcpApp();
  
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">Welcome to the MCP Utilities</h1>
        <p className="text-lg text-gray-600">This is a static page rendered in an MCP widget.</p>
      </div>
    </main>
  );
}