import { timingSafeEqual } from "node:crypto";

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};

export const isAuthorizedMcpRequest = (req) => {
  const token = process.env.DUPTRACE_INTERNAL_MCP_TOKEN?.trim();
  if (!token) return false;
  return safeEqual(req?.headers?.["x-duptrace-internal-token"] || "", token);
};
