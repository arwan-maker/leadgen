// Local stand-in for Vercel: serves public/ and runs api/*.js. Usage: npm run dev
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice(5).replace(/\/+$/, "");
    if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*$/i.test(name)) { res.statusCode = 404; return res.end("not found"); }
    req.query = Object.fromEntries(url.searchParams);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
    try {
      var { default: handler } = await import(join(root, "api", `${name}.js`));
    } catch (err) {
      if (err.code !== "ERR_MODULE_NOT_FOUND") console.error(err);
      res.statusCode = 404; return res.end("not found");
    }
    return handler(req, res);
  }
  const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
  try {
    const data = await readFile(join(root, "public", path));
    res.setHeader("Content-Type", types[extname(path)] || "application/octet-stream");
    res.end(data);
  } catch {
    res.statusCode = 404; res.end("not found");
  }
}).listen(process.env.PORT || 3000, () => console.log(`LeadGEN dev server on http://localhost:${process.env.PORT || 3000}`));
