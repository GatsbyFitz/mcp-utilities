// app/page.tsx
export default function Page() {
  return (
    <html>
      <head>
        <title>Get Time App</title>
        {/* All styles must be explicitly inlined */}
        <style>{`
          body { font-family: sans-serif; padding: 20px; background: #fff; }
          .card { border: 1px solid #ccc; padding: 16px; border-radius: 8px; }
        `}</style>
      </head>
      <body>
        <div className="card">
          <h1>Get Time Widget</h1>
          <div id="time-display">Loading...</div>
        </div>

        {/* All Javascript logic must be strictly inlined without imports */}
        <script dangerouslySetInnerHTML={{ __html: `
          console.log("Widget initialized inside iframe");
          document.getElementById("time-display").innerText = new Date().toLocaleTimeString();
        `}} />
      </body>
    </html>
  );
}
