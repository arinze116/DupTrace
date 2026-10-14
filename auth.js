import { createHmac, createHash, timingSafeEqual } from "node:crypto";
const COOKIE_NAME = "duptrace_session";
const SESSION_SECONDS = 12 * 60 * 60;
const secret = () => process.env.DUPTRACE_SESSION_SECRET?.trim() || "";
const password = () => process.env.DUPTRACE_ACCESS_PASSWORD || "";
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};
const signature = (payload, key) => createHmac("sha256", key).update(payload).digest("base64url");
export const verifyAccessPassword = (candidate) => {
  const configured = password();
  if (!configured || typeof candidate !== "string") return false;
  return safeEqual(createHash("sha256").update(candidate).digest(), createHash("sha256").update(configured).digest());
};
export const createSessionCookie = (now = Date.now()) => {
  const key = secret();
  if (!key || !password()) throw new Error("Hosted access authentication is not configured.");
  const expires = Math.floor(now / 1000) + SESSION_SECONDS; const payload = String(expires);
  return `${COOKIE_NAME}=${payload}.${signature(payload, key)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
};
export const hasValidSession = (req, now = Date.now()) => {
  const key = secret(); if (!key || !password()) return false;
  const cookieHeader = req?.headers?.cookie || "";
  const pair = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(COOKIE_NAME + "="));
  if (!pair) return false;
  const token = pair.slice(COOKIE_NAME.length + 1); const dot = token.indexOf(".");
  if (dot < 1) return false;
  const payload = token.slice(0, dot); const supplied = token.slice(dot + 1);
  if (!/^\d{10}$/.test(payload) || Number(payload) <= Math.floor(now / 1000)) return false;
  return safeEqual(supplied, signature(payload, key));
};
export const isAuthorizedMcpRequest = (req) => {
  const token = process.env.DUPTRACE_INTERNAL_MCP_TOKEN?.trim(); if (!token) return false;
  return safeEqual(req?.headers?.["x-duptrace-internal-token"] || "", token);
};
