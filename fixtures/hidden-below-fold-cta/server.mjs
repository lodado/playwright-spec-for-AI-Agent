import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4179);
const server = createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/complete") {
    response.end("<!doctype html><title>Complete</title><h1>Behavioral report ready</h1>");
    return;
  }
  response.end(`<!doctype html>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Hidden CTA fixture</title>
    <main style="font: 18px system-ui; max-width: 42rem; margin: auto">
      <h1>Your upload is complete</h1>
      <p>The candidate release adds enough explanation to push the next action below the initial viewport.</p>
      <div style="height: 1050px" aria-hidden="true"></div>
      <a href="/complete" style="display:inline-block;padding:16px 24px;background:#1459d9;color:white">Open behavioral report</a>
    </main>`);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Hidden CTA fixture: http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
