export default function Page() {
  return (
    <html lang="en">
      <head>
        <title>Get Time App</title>
        <style>{`
          body { 
            font-family: system-ui, -apple-system, sans-serif; 
            padding: 16px; 
            background: #121212; 
            color: #ffffff; 
            margin: 0;
            display: flex;
            justify-content: center;
          }
          .card { 
            border: 1px solid #2a2a2a; 
            padding: 20px; 
            border-radius: 12px; 
            background: #1a1a1a; 
            width: 100%;
            max-width: 280px; 
            text-align: center;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
          }
          h1 { 
            margin: 0 0 12px 0; 
            font-size: 1.1rem; 
            color: #a78bfa; 
            text-transform: uppercase;
            letter-spacing: 0.05em;
          }
          #time-display { 
            font-family: monospace; 
            font-size: 1.75rem; 
            font-weight: bold; 
            color: #34d399; 
          }
        `}</style>
      </head>
      <body>
        <div className="card">
          <h1>Get Time Widget</h1>
          <div id="time-display">00:00:00</div>
        </div>

        <script dangerouslySetInnerHTML={{ __html: `
          console.log("Static MCP Widget loaded");

          // 1. Calculate time directly on the client side
          function updateClock() {
            document.getElementById("time-display").innerText = new Date().toLocaleTimeString();
          }
          
          // Initialise and run clock tick
          updateClock();
          setInterval(updateClock, 1000);

          // 2. CRITICAL: Handshake to let the MCP host container know it's safe to render
          window.parent.postMessage({ type: "mcp-app-ready" }, "*");
        `}} />
      </body>
    </html>
  );
}
