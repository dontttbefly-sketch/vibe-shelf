import path from "node:path";
import { isInsideRoot } from "./ids.mjs";

export function httpError(message, statusCode = 500, kind = "server") {
  return Object.assign(new Error(message), { statusCode, kind });
}

export async function readJsonBody(req, maxBytes = 12 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw httpError("request body too large", 413, "too-large");
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw httpError("invalid JSON request body", 400, "bad-request");
  }
}

export function safeStaticPath(publicDir, urlPath) {
  const requestPath = urlPath === "/" ? "/index.html" : urlPath;
  const candidate = path.resolve(publicDir, `.${requestPath}`);
  return isInsideRoot(publicDir, candidate) ? candidate : null;
}

export function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
