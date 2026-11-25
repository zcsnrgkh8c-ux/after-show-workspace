/**
 * 稳定公网链接用的静态服务器（无第三方依赖）：
 * - 服务 web/dist（生产构建），SPA 路由回退 index.html；
 * - 把 /api/* 反向代理到本机 8787，页面用同源相对路径即可，手机经 HTTPS 隧道访问时无需跨域；
 * - 仅监听 127.0.0.1，由 cloudflared 命名隧道对外暴露，不直接开公网端口。
 *
 * 用法：node scripts/serve-public.mjs（默认端口 8791，可用 PORT 覆盖）
 */
import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web/dist");
const PORT = Number(process.env.PORT ?? 8791);
const API_HOST = "127.0.0.1";
const API_PORT = 8787;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function proxyApi(req, res) {
  const upstream = http.request(
    {
      host: API_HOST,
      port: API_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${API_HOST}:${API_PORT}` },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`upstream error: ${err.message}`);
  });
  req.pipe(upstream);
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let filePath = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    if (statSync(filePath).isDirectory()) filePath = path.join(filePath, "index.html");
    statSync(filePath);
  } catch {
    // SPA fallback：仅无扩展名的 GET 回退 index.html
    if (req.method === "GET" && path.extname(urlPath) === "") {
      filePath = path.join(ROOT, "index.html");
    } else {
      res.writeHead(404);
      res.end("not found");
      return;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const isHtml = ext === ".html";
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": isHtml ? "no-store" : "public, max-age=3600",
  });
  createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  if ((req.url ?? "").startsWith("/api/")) {
    proxyApi(req, res);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("method not allowed");
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[public] http://127.0.0.1:${PORT} -> web/dist, /api -> ${API_HOST}:${API_PORT}`);
});
