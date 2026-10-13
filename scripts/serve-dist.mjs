import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "dist");
const host = "127.0.0.1";
const port = 4173;
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? "/", `http://${host}`).pathname);
  const relativePath = normalize(pathname).replace(/^([/\\])+/, "");
  const candidate = join(root, relativePath);
  const file = relativePath && existsSync(candidate) ? candidate : join(root, "index.html");
  response.setHeader("Content-Type", contentTypes.get(extname(file)) ?? "application/octet-stream");
  createReadStream(file).on("error", () => {
    response.statusCode = 404;
    response.end("Not found");
  }).pipe(response);
});

server.listen(port, host, () => console.log(`YT Jam preview ready at http://${host}:${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
