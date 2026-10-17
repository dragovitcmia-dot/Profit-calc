// Tiny static server for public/ (used by the e2e tests, or `npm run serve` for a manual look).
// `mutate` lets a test rewrite a file on the fly to simulate a new deploy.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "public");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/manifest+json; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon"
};

function createServer() {
  const mutations = {};                       // "/app.js" -> (text) => text
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("not found");
    }
    let body = fs.readFileSync(file);
    if (mutations[p]) body = Buffer.from(mutations[p](body.toString("utf8")));
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "public, max-age=0, must-revalidate"
    });
    res.end(body);
  });
  return { server, mutations };
}

module.exports = { createServer };

if (require.main === module) {
  const { server } = createServer();
  const port = Number(process.env.PORT) || 8080;
  server.listen(port, () => console.log("http://localhost:" + port));
}
