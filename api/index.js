// Vercel Node.js function entry point. server.js only calls listen() locally.
// The rewrite mounts this function under /api/index/:path*. Restore the original
// Express pathname before dispatch so /, /api/chat, /mcp and static assets route normally.
import app from "../server.js";
export default function handler(req, res) {
  if (typeof req.url === "string" && req.url.startsWith("/api/index")) {
    req.url = req.url.slice("/api/index".length) || "/";
    if (req.url.startsWith("?")) req.url = "/" + req.url;
  }
  return app(req, res);
}
