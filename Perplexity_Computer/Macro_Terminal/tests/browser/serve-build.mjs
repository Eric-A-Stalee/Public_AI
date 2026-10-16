// Exercise the built app under its actual nested GitHub Pages URL.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, resolve, sep } from "node:path";

const root = fileURLToPath(new URL("../../dist/", import.meta.url));
const prefix = "/Public_AI/Perplexity_Computer/Macro_Terminal/";
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    );
    if (!pathname.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    const relative = pathname.slice(prefix.length) || "index.html";
    const file = resolve(root, relative);
    if (!file.startsWith(resolve(root) + sep)) {
      response.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    response
      .writeHead(200, {
        "Content-Type":
          contentTypes[extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
      })
      .end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(4173, "127.0.0.1");
