/**
 * Forge Adapter Utilities
 *
 * Shared utilities for the Forge adapter, including token redaction
 * and safe error handling to prevent secret leakage.
 */

// Patterns that indicate sensitive values to redact
const SENSITIVE_PATTERNS = [
  /bearer\s+[a-zA-Z0-9_\-\.]+/gi,
  /(?:^|\s)token\s*[:=]\s*["']?[a-zA-Z0-9_\-\.]+["']?/gi,
  /(?:^|\s)api[_-]?token\s*[:=]\s*["']?[a-zA-Z0-9_\-\.]+["']?/gi,
  /(?:^|\s)forge[_-]?api[_-]?token\s*[:=]\s*["']?[a-zA-Z0-9_\-\.]+["']?/gi,
  /(?:^|\s)authorization\s*[:=]\s*["']?[^"'\s]+["']?/gi,
];

// Keys that should have their values redacted in objects
const SENSITIVE_KEYS = new Set([
  "forgeapitoken",
  "forge_api_token",
  "forgeonapitoken",
  "token",
  "apitoken",
  "api_token",
  "authorization",
  "auth",
  "bearer",
  "password",
  "secret",
  "apikey",
  "api_key",
]);

/**
 * Redact sensitive values from a string, replacing them with [REDACTED].
 */
export function redactSensitiveValues(input: string): string {
  let result = input;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, (match) => {
      // Keep the prefix (like "Bearer " or "token: ") but redact the value
      const prefixMatch = match.match(/^(.*?[:=\s]+)/i);
      if (prefixMatch) {
        return prefixMatch[1] + "[REDACTED]";
      }
      return "[REDACTED]";
    });
  }
  return result;
}

/**
 * Redact sensitive values from an object's string properties.
 * Returns a new object with sensitive values replaced.
 */
export function redactSensitiveObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const lowerKey = key.toLowerCase();
    const value = obj[key];
    if (SENSITIVE_KEYS.has(lowerKey)) {
      if (typeof value === "string" && value) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = value;
      }
    } else if (typeof value === "string") {
      if (value.length > 0) {
        result[key] = redactSensitiveValues(value);
      } else {
        result[key] = value;
      }
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = redactSensitiveObject(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Create safe headers for logging/metrics by redacting Authorization header.
 */
export function redactHeadersForLogging(headers: Record<string, string>): Record<string, string> {
  const result = { ...headers };
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === "authorization") {
      result[key] = "[REDACTED]";
    }
  }
  return result;
}

/**
 * Safely stringify an error for logging, ensuring no tokens are leaked.
 */
export function safeErrorStringify(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveValues(`${error.name}: ${error.message}`);
  }
  if (typeof error === "string") {
    return redactSensitiveValues(error);
  }
  try {
    return redactSensitiveValues(JSON.stringify(error));
  } catch {
    return "[Unable to stringify error]";
  }
}

/**
 * Validate and normalize a Forge API URL.
 * Returns null if invalid or not http/https.
 */
export function normalizeForgeUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build Forge API endpoint URL.
 */
export function buildForgeEndpoint(baseUrl: string, path: string): string {
  const normalized = normalizeForgeUrl(baseUrl);
  if (!normalized) {
    throw new Error("Invalid Forge API URL");
  }
  // Remove trailing slash from base URL and ensure path starts with /
  const base = normalized.toString().replace(/\/$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${cleanPath}`;
}
