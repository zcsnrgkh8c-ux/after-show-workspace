import http from "node:http";
import { ApiErrorBody } from "../shared/types";
import {
  ApiError,
  compare,
  generate,
  health,
  parseScene,
  readJsonBody,
  simulate,
  toApiError,
} from "./api/handlers";
import { engine } from "./decision/engine_port";
import { llmConfigured } from "./decision/llm";
import { travelAdvice } from "./travel/handler";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendError(res: http.ServerResponse, error: ApiError): void {
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
  sendJson(res, error.status, body);
}

type Route = (body: unknown) => unknown | Promise<unknown>;

const POST_ROUTES: Record<string, Route> = {
  "/api/scenario/parse": parseScene,
  "/api/plan/generate": generate,
  "/api/simulate": simulate,
  "/api/compare": compare,
  "/api/travel/advice": travelAdvice,
};

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const method = (req.method || "GET").toUpperCase();
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (pathname === "/api/health") {
      if (method !== "GET") {
        sendError(res, new ApiError(405, "method_not_allowed", "仅支持 GET /api/health"));
        return;
      }
      sendJson(res, 200, health());
      return;
    }

    const route = POST_ROUTES[pathname];
    if (!route) {
      sendError(res, new ApiError(404, "not_found", `未找到接口：${method} ${pathname}`));
      return;
    }
    if (method !== "POST") {
      sendError(res, new ApiError(405, "method_not_allowed", `仅支持 POST ${pathname}`));
      return;
    }

    try {
      const body = await readJsonBody(req);
      const result = await route(body);
      sendJson(res, 200, result);
    } catch (error) {
      sendError(res, toApiError(error));
    }
  });
}

function start(): void {
  const rawPort = process.env.PORT ?? "8787";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`[启动失败] PORT 不是合法端口：${rawPort}`);
    process.exit(1);
  }

  const server = createServer();
  server.listen(port, () => {
    console.log(`[散场之后] 服务已启动：http://localhost:${port}`);
    console.log(`[散场之后] engine=${engine.source} version=${engine.version}`);
    console.log(`[散场之后] llm_configured=${llmConfigured()}（mode 由实际调用决定）`);
    console.log("[散场之后] 接口：GET /api/health，POST /api/scenario/parse|plan/generate|simulate|compare|travel/advice");
  });
}

if (require.main === module) {
  start();
}
