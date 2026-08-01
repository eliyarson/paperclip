/**
 * Forge-Cerebro Memory Bridge Configuration
 *
 * Opt-in configuration for the Forge-to-Cerebro memory bridge.
 * Defaults to disabled/no-op when feature flag, URL, or credentials are absent.
 * Reuses existing Paperclip Cerebro timeout and bounds conventions.
 *
 * @checkpoint paperclip-forge-cerebro-memory-bridge-v0
 * @requirements REQ-007, REQ-008, REQ-010
 */

import type { Config } from "../config.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";

/**
 * Forge bridge configuration parsed from environment variables.
 * All credentials are server-held only and redacted in logs/metadata.
 */
export interface ForgeBridgeConfig {
  /** Whether the bridge is enabled. Default: false when no URL/credentials configured. */
  enabled: boolean;

  /** Feature flag override. Set to "true" to enable, "false" to force disable. */
  featureFlag: boolean | undefined;

  /** Cerebro base URL for Forge bridge (used for context injection). */
  cerebroUrl: string | undefined;

  /** Cerebro observations endpoint URL for Forge bridge (explicit, or derived from cerebroUrl). */
  cerebroObservationsUrl: string | undefined;

  /** Bearer token for Cerebro authentication (server-only). */
  cerebroToken: string | undefined;

  /** HTTP timeout in milliseconds. Default: 5000ms. */
  timeoutMs: number;

  /** Maximum observations per batch write. Default: 10. */
  maxObservationsPerBatch: number;

  /** Maximum characters per observation content. Default: 5000. */
  maxCharsPerObservation: number;

  /** Maximum total characters for batch payload. Default: 50000. */
  maxTotalChars: number;

  /** Whether to redact all secrets from observation content. Default: true. */
  redactionEnabled: boolean;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_OBSERVATIONS = 10;
const DEFAULT_MAX_CHARS_PER_OBS = 5000;
const DEFAULT_MAX_TOTAL_CHARS = 50000;

/**
 * Parse Forge bridge configuration from environment variables.
 *
 * The bridge is disabled by default unless explicitly configured with:
 * - PAPERCLIP_CEREBRO_FORGE_URL (required)
 * - PAPERCLIP_CEREBRO_FORGE_TOKEN (required for actual writes)
 *
 * The feature flag PAPERCLIP_CEREBRO_FORGE_ENABLED can be used to:
 * - "true": Force enable (requires URL)
 * - "false": Force disable (no-op regardless of other config)
 *
 * @requirements REQ-007, REQ-010
 */
export function parseForgeBridgeConfig(
  _config: Config,
  env: NodeJS.ProcessEnv = process.env,
): ForgeBridgeConfig {
  const cerebroUrl = env.PAPERCLIP_CEREBRO_FORGE_URL?.trim() || undefined;
  const cerebroObservationsUrl = env.PAPERCLIP_CEREBRO_FORGE_OBSERVATIONS_URL?.trim() || undefined;
  const cerebroToken = env.PAPERCLIP_CEREBRO_FORGE_TOKEN?.trim() || undefined;
  const enabledFromEnv = env.PAPERCLIP_CEREBRO_FORGE_ENABLED?.trim();

  // Feature flag: explicit "false" forces disabled
  // Explicit "true" forces enabled (but still requires URL for actual operation)
  // Default: enabled only if URL is configured
  let enabled: boolean;
  let featureFlag: boolean | undefined;

  if (enabledFromEnv === "false") {
    enabled = false;
    featureFlag = false;
  } else if (enabledFromEnv === "true") {
    enabled = !!cerebroUrl;
    featureFlag = true;
  } else {
    // Default: enabled only if URL is configured
    enabled = !!cerebroUrl;
    featureFlag = undefined;
  }

  // Reuse Paperclip Cerebro timeout conventions with Forge-specific overrides
  const timeoutMs = Math.max(
    1000,
    Math.min(
      30000,
      Number(env.PAPERCLIP_CEREBRO_FORGE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    ),
  );

  // Bounds for observation batching
  const maxObservationsPerBatch = Math.max(
    1,
    Math.min(
      50,
      Number(env.PAPERCLIP_CEREBRO_FORGE_MAX_OBSERVATIONS) || DEFAULT_MAX_OBSERVATIONS,
    ),
  );

  const maxCharsPerObservation = Math.max(
    100,
    Math.min(
      20000,
      Number(env.PAPERCLIP_CEREBRO_FORGE_MAX_CHARS) || DEFAULT_MAX_CHARS_PER_OBS,
    ),
  );

  const maxTotalChars = Math.max(
    1000,
    Math.min(
      200000,
      Number(env.PAPERCLIP_CEREBRO_FORGE_MAX_TOTAL_CHARS) || DEFAULT_MAX_TOTAL_CHARS,
    ),
  );

  // Redaction is enabled by default, can be disabled for debugging only
  const redactionEnabled = env.PAPERCLIP_CEREBRO_FORGE_REDACTION !== "false";

  return {
    enabled,
    featureFlag,
    cerebroUrl,
    cerebroObservationsUrl,
    cerebroToken,
    timeoutMs,
    maxObservationsPerBatch,
    maxCharsPerObservation,
    maxTotalChars,
    redactionEnabled,
  };
}

/**
 * Get redacted configuration for logging/audit purposes.
 * All credential values are replaced with REDACTED_EVENT_VALUE.
 *
 * @requirements REQ-010
 */
export function getRedactedForgeBridgeConfig(
  config: ForgeBridgeConfig,
): Omit<ForgeBridgeConfig, "cerebroToken"> & { cerebroToken: typeof REDACTED_EVENT_VALUE | undefined } {
  return {
    ...config,
    cerebroToken: config.cerebroToken ? REDACTED_EVENT_VALUE : undefined,
  };
}

/**
 * Check if the Forge bridge is effectively enabled for operation.
 * Requires both enabled flag and URL configuration.
 */
export function isForgeBridgeEnabled(config: ForgeBridgeConfig): boolean {
  return config.enabled && !!config.cerebroUrl;
}

/**
 * Build audit metadata for the bridge configuration.
 * Safe for logging - all secrets are redacted.
 */
export interface ForgeBridgeAuditMetadata {
  enabled: boolean;
  feature_flag: boolean | undefined;
  configured: boolean;
  timeout_ms: number;
  max_observations: number;
  max_chars_per_obs: number;
  max_total_chars: number;
  redaction_enabled: boolean;
}

export function buildForgeBridgeAuditMetadata(config: ForgeBridgeConfig): ForgeBridgeAuditMetadata {
  return {
    enabled: config.enabled,
    feature_flag: config.featureFlag,
    configured: !!config.cerebroUrl,
    timeout_ms: config.timeoutMs,
    max_observations: config.maxObservationsPerBatch,
    max_chars_per_obs: config.maxCharsPerObservation,
    max_total_chars: config.maxTotalChars,
    redaction_enabled: config.redactionEnabled,
  };
}
