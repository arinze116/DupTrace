// Vercel Node.js function entry point. server.js only calls listen() locally.
// vercel.json rewrites requests to this function while preserving the original path
// in a query parameter. Restore the Express path and retain the user's query.
import app from "../server.js";
export default function handler(req, res) {
  if (typeof req.url === "string") {
    const url = new URL(req.url, "http://localhost");
    const originalPath = url.searchParams.get("__duptrace_path");
    if (originalPath && originalPath.startsWith("/") && !originalPath.startsWith("//")) {
      url.searchParams.delete("__duptrace_path");
      req.url = originalPath + url.search;
    }
  }
  return app(req, res);
}
