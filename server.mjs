import { createServer as createHttpServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const publicDir = resolve(projectDir, "public");
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function resolvePublicFile(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === "/" || decoded === "/shop" || decoded === "/shop/"
    ? "index.html"
    : decoded.replace(/^\/+/, "");
  let filePath = resolve(publicDir, relative);
  if (filePath !== publicDir && !filePath.startsWith(publicDir + sep)) return null;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = resolve(filePath, "index.html");
    return filePath;
  } catch {
    // Deep-link routes should load the shop shell so its history state can rehydrate.
    if (decoded.startsWith("/shop/")) return resolve(publicDir, "index.html");
    return null;
  }
}

export function createDemoServer({ host = "127.0.0.1", port = Number(process.env.PORT || 4173) } = {}) {
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
      response.end("Method not allowed");
      return;
    }
    const filePath = await resolvePublicFile(url.pathname);
    if (!filePath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
  return { server, host, port };
}

export async function listenDemoServer(options = {}) {
  const instance = createDemoServer(options);
  await new Promise((resolveListen, reject) => {
    instance.server.once("error", reject);
    instance.server.listen(instance.port, instance.host, resolveListen);
  });
  return instance;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, host, port } = await listenDemoServer();
  console.log(`StillHere sample shop running at http://${host}:${port}/`);
  console.log("Press Ctrl+C to stop.");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
