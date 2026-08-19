const localhostOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

export function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

export function configuredCorsOrigins(env = process.env) {
  return new Set(
    [env.APP_URL, ...String(env.CORS_ORIGINS || "").split(",")]
      .map(normalizeOrigin)
      .filter(Boolean),
  );
}

export function isAllowedCorsOrigin(origin, configuredOrigins) {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  // Agentie's web development server and installed WebView both use a
  // loopback origin. API authentication is still enforced on every route.
  return configuredOrigins.has(normalized) || localhostOrigin.test(normalized);
}
