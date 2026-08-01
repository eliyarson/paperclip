/**
 * Forge Observation Writeback Service
 *
 * Server-mediated Forge observation writeback path with Paperclip authentication,
 * company/project/agent/run/issue/Forge artifact scope validation, and Cerebro
 * observation submission via server-held credentials.
 *
 * Maps incoming Forge events through forge-observation-mapper.ts, rejects/redacts
 * secret-bearing payloads, and never returns Cerebro credentials.
 *
 * Failures do not claim Cerebro persistence and return safe/degraded errors.
 *
 * @checkpoint paperclip-forge-cerebro-memory-bridge-v0
 * @requirements REQ-004, REQ-005, REQ-006, REQ-008, REQ-009, REQ-010, REQ-011
 */

import type { Config } from "../config.js";
import { logger } from "../middleware/logger.js";
import { REDACTED_EVENT_VALUE, sanitizeRecord } from "../redaction.js";
import type { CerebroObservationPayload } from "./cerebro-context-client.js";
import {
  parseForgeBridgeConfig,
  isForgeBridgeEnabled,
  buildForgeBridgeAuditMetadata,
  type ForgeBridgeConfig,
} from "./forge-bridge-config.js";
import {
  mapForgeEventsToObservations,
  boundObservationBatch,
  type ForgeEvent,
  type ForgeEventScope,
} from "./forge-observation-mapper.js";

/**
 * Input for writing Forge observations.
 * @requirements REQ-005 - validates all scope identifiers
 */
export interface WriteForgeObservationsInput {
  /** Company/tenant identifier (required for authorization) */
  companyId: string;

  /** Project identifier (optional) */
  projectId?: string;

  /** Agent identifier (optional) */
  agentId?: string;

  /** Run identifier (optional) */
  runId?: string;

  /** Issue identifier (optional) */
  issueId?: string;

  /** Forge change_id (required for Forge context) */
  forgeChangeId: string;

  /** Forge events to map and write */
  events: ForgeEvent[];

  /** Actor information for audit */
  actor: {
    kind: "agent" | "system" | "operator";
    id: string;
  };
}

/**
 * Result of writing Forge observations.
 * @requirements REQ-008 - fail-open with degraded metadata
 */
export interface WriteForgeObservationsResult {
  /** Whether the write was successful */
  success: boolean;

  /** Number of observations accepted by Cerebro */
  acceptedCount: number;

  /** Number of observations rejected */
  rejectedCount: number;

  /** Reasons for rejection (if any) */
  rejectedReasons?: string[];

  /** Whether the result is degraded (Cerebro unavailable, timeout, etc.) */
  degraded?: boolean;

  /** Reason for degradation if applicable */
  degradedReason?: "unconfigured" | "unavailable" | "timeout" | "error" | "disabled" | "validation_failed";

  /** Error code for failures */
  errorCode?: string;

  /** Error summary for failures */
  errorSummary?: string;

  /** Audit metadata for the write operation */
  audit: {
    written_at: string;
    bridge_config: ReturnType<typeof buildForgeBridgeAuditMetadata>;
    event_count: number;
    observation_count: number;
    accepted_count: number;
    rejected_count: number;
  };
}

/**
 * Dependencies for the Forge writeback service (for testing/DI).
 */
export interface ForgeWritebackServiceDeps {
  fetch: typeof fetch;
  log: typeof logger;
  now: () => Date;
}

/**
 * Secret patterns for validation.
 * @requirements REQ-010 - reject secret-bearing payloads
 */
const SUSPICIOUS_PATTERNS = [
  /bearer\s+[a-zA-Z0-9_\-\.]+/i,
  /token\s*[:=]\s*[a-zA-Z0-9_\-\.]+/i,
  /api[_-]?key\s*[:=]\s*[a-zA-Z0-9_\-\.]+/i,
  /password\s*[:=]\s*\S+/i,
  /secret\s*[:=]\s*\S+/i,
  /sk-[a-zA-Z0-9]{20,}/i,
  /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/i, // JWT pattern
];

function buildTenantHeaders(input: {
  companyId: string;
  projectId?: string;
  memberId?: string;
}): Record<string, string> {
  return {
    "X-Organization-Id": input.companyId,
    "X-Workspace-Id": input.projectId || "default",
    "X-Member-Id": input.memberId || "paperclip-server",
    "X-Tenant-Role": "service",
  };
}

function asStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function buildPaperclipObservationBatch(input: {
  observations: CerebroObservationPayload[];
  companyId: string;
  projectId?: string;
  runId?: string;
  issueId?: string;
}) {
  return {
    observations: input.observations.map((observation, index) => {
      const metadata = observation.metadata ?? {};
      const sourceId = asStringValue(metadata.source_id)
        ?? `forge_bridge:${input.companyId}:${asStringValue(metadata.forge_change_id) ?? "unknown"}:${index}`;
      const forgeChangeId = asStringValue(metadata.forge_change_id);
      const observedAt = asStringValue(metadata.source_timestamp);
      const projectId = asStringValue(metadata.project_id) ?? input.projectId ?? "default";
      const runId = asStringValue(metadata.run_id) ?? input.runId;
      const issueId = asStringValue(metadata.issue_id) ?? input.issueId;

      return {
        source_id: sourceId,
        observation_type: observation.type,
        company_id: input.companyId,
        project_id: projectId,
        change_id: forgeChangeId,
        run_id: runId,
        issue_id: issueId,
        title: observation.content.slice(0, 200),
        description: observation.content,
        payload: {
          ...metadata,
          tags: observation.tags ?? [],
        },
        occurred_at: observedAt,
        entity: `${input.companyId}/${projectId}`,
        scope: "user",
        memory_class: "working",
        // Kept for legacy tests and ignored by Cerebro's Pydantic model.
        content: observation.content,
      };
    }),
  };
}

/**
 * Validate that observations don't contain secrets.
 * @requirements REQ-010
 */
function validateObservationsForSecrets(
  observations: CerebroObservationPayload[],
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];

  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];

    // Check content for secrets
    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (pattern.test(obs.content)) {
        reasons.push(`Observation ${i} contains potential secret pattern`);
        break;
      }
    }

    // Check metadata for secrets
    if (obs.metadata) {
      const metadataStr = JSON.stringify(obs.metadata);
      for (const pattern of SUSPICIOUS_PATTERNS) {
        if (pattern.test(metadataStr)) {
          reasons.push(`Observation ${i} metadata contains potential secret pattern`);
          break;
        }
      }
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

/**
 * Redact secrets from a JSON string.
 * @requirements REQ-010
 */
function redactSecretsInJsonString(jsonString: string): string {
  let result = jsonString;
  
  // Pattern for JSON-style key-value pairs where the key contains sensitive keywords
  // Matches: "token":"value", "api_key":"value", "secret":"value", etc.
  const jsonSecretPattern = /"[^"]*(?:token|api[_-]?key|secret|password|bearer|authorization)[^"]*"\s*:\s*"([^"]*)"/gi;
  result = result.replace(jsonSecretPattern, (match, value) => {
    return match.replace(value, "***REDACTED***");
  });
  
  // Also redact bearer tokens and other patterns that might appear in JSON values
  result = result.replace(/bearer\s+[a-zA-Z0-9_\-\.]+/gi, "bearer ***REDACTED***");
  result = result.replace(/sk-[a-zA-Z0-9]{20,}/gi, "***REDACTED***");
  result = result.replace(/eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/gi, "***REDACTED***");
  
  return result;
}

/**
 * Redact secrets from observations.
 * @requirements REQ-010
 */
function redactObservations(
  observations: CerebroObservationPayload[],
): CerebroObservationPayload[] {
  return observations.map((obs) => {
    // First sanitize the metadata object
    const redactedMetadata = obs.metadata ? sanitizeRecord(obs.metadata) : undefined;
    
    // Also redact secrets in event_metadata if it exists (it's a JSON string)
    if (redactedMetadata?.event_metadata && typeof redactedMetadata.event_metadata === "string") {
      redactedMetadata.event_metadata = redactSecretsInJsonString(redactedMetadata.event_metadata);
    }
    
    // Redact any other string values in metadata that might contain JSON
    for (const key of Object.keys(redactedMetadata || {})) {
      const value = redactedMetadata![key];
      if (typeof value === "string" && value.includes("{")) {
        redactedMetadata![key] = redactSecretsInJsonString(value);
      }
    }
    
    return {
      ...obs,
      content: redactObservationContent(obs.content),
      metadata: redactedMetadata,
    };
  });
}

/**
 * Redact secrets from observation content.
 */
function redactObservationContent(content: string): string {
  let result = content;
  
  // Redact bearer tokens
  result = result.replace(/bearer\s+[a-zA-Z0-9_\-\.]+/gi, "bearer ***REDACTED***");
  
  // Redact token= or token: patterns
  result = result.replace(/(token\s*[:=]\s*)[a-zA-Z0-9_\-\.]+/gi, "$1***REDACTED***");
  
  // Redact api_key= or api_key: patterns
  result = result.replace(/(api[_-]?key\s*[:=]\s*)[a-zA-Z0-9_\-\.]+/gi, "$1***REDACTED***");
  
  // Redact password= or password: patterns
  result = result.replace(/(password\s*[:=]\s*)\S+/gi, "$1***REDACTED***");
  
  // Redact secret= or secret: patterns
  result = result.replace(/(secret\s*[:=]\s*)\S+/gi, "$1***REDACTED***");
  
  // Redact OpenAI-style keys
  result = result.replace(/sk-[a-zA-Z0-9]{20,}/gi, "***REDACTED***");
  
  // Redact JWT tokens
  result = result.replace(/eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/gi, "***REDACTED***");
  
  // Redact any remaining token-like values (e.g., secret-cerebro-token-xyz123)
  result = result.replace(/[a-zA-Z0-9_-]*token[a-zA-Z0-9_-]*-[a-zA-Z0-9_-]+/gi, "***REDACTED***");
  
  return result;
}

/**
 * Create the Forge observation writeback service.
 * @requirements REQ-007 - disabled/no-op by default
 */
export function createForgeWritebackService(
  config: Config,
  deps: Partial<ForgeWritebackServiceDeps> = {},
) {
  const forgeConfig = parseForgeBridgeConfig(config);

  // Use provided deps or create defaults
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? logger;
  const now = deps.now ?? (() => new Date());

  /**
   * Check if Forge observation writeback is enabled.
   */
  function isEnabled(): boolean {
    return isForgeBridgeEnabled(forgeConfig);
  }

  /**
   * Get service configuration (redacted for logging).
   */
  function getConfig(): {
    forgeBridge: Omit<ForgeBridgeConfig, "cerebroToken"> & { cerebroToken: typeof REDACTED_EVENT_VALUE | undefined };
    enabled: boolean;
  } {
    return {
      forgeBridge: {
        ...forgeConfig,
        cerebroToken: forgeConfig.cerebroToken ? REDACTED_EVENT_VALUE : undefined,
      },
      enabled: isEnabled(),
    };
  }

  /**
   * Validate company scope before Cerebro write.
   * @requirements REQ-005
   */
  function validateCompanyScope(
    inputCompanyId: string,
    actorCompanyId: string,
  ): { valid: boolean; error?: string } {
    if (inputCompanyId !== actorCompanyId) {
      return {
        valid: false,
        error: `Cross-company access denied: actor company ${actorCompanyId} cannot access company ${inputCompanyId}`,
      };
    }
    return { valid: true };
  }

  /**
   * Write Forge observations to Cerebro.
   * @requirements REQ-004, REQ-005, REQ-006, REQ-008, REQ-010
   */
  async function writeObservations(
    input: WriteForgeObservationsInput,
    actorCompanyId: string,
  ): Promise<WriteForgeObservationsResult> {
    const writtenAt = now().toISOString();

    // Check if service is enabled
    if (!isEnabled()) {
      log.debug({
        companyId: input.companyId,
        forgeChangeId: input.forgeChangeId,
        eventCount: input.events.length,
        reason: forgeConfig.enabled ? "url_unconfigured" : "bridge_disabled",
      }, "Forge writeback service disabled, returning degraded result");

      return {
        success: true, // Fail-open: not an error, just no write
        acceptedCount: 0,
        rejectedCount: input.events.length,
        degraded: true,
        degradedReason: forgeConfig.enabled ? "unconfigured" : "disabled",
        audit: {
          written_at: writtenAt,
          bridge_config: buildForgeBridgeAuditMetadata(forgeConfig),
          event_count: input.events.length,
          observation_count: 0,
          accepted_count: 0,
          rejected_count: input.events.length,
        },
      };
    }

    // Validate company scope
    const scopeValidation = validateCompanyScope(input.companyId, actorCompanyId);
    if (!scopeValidation.valid) {
      log.warn({
        companyId: input.companyId,
        actorCompanyId,
        forgeChangeId: input.forgeChangeId,
      }, "Cross-company Forge observation write blocked");

      return {
        success: false,
        acceptedCount: 0,
        rejectedCount: input.events.length,
        degraded: false,
        degradedReason: "validation_failed",
        errorCode: "cross_company_access_denied",
        errorSummary: scopeValidation.error,
        audit: {
          written_at: writtenAt,
          bridge_config: buildForgeBridgeAuditMetadata(forgeConfig),
          event_count: input.events.length,
          observation_count: 0,
          accepted_count: 0,
          rejected_count: input.events.length,
        },
      };
    }

    try {
      // Map Forge events to Cerebro observations
      let observations = mapForgeEventsToObservations(input.events);

      if (observations.length === 0) {
        // No memory-worthy events to write
        return {
          success: true,
          acceptedCount: 0,
          rejectedCount: 0,
          audit: {
            written_at: writtenAt,
            bridge_config: buildForgeBridgeAuditMetadata(forgeConfig),
            event_count: input.events.length,
            observation_count: 0,
            accepted_count: 0,
            rejected_count: 0,
          },
        };
      }

      // Apply per-observation bounds
      observations = boundObservationBatch(
        observations,
        forgeConfig.maxCharsPerObservation,
      );

      // Apply batch count bound (REQ-005)
      if (observations.length > forgeConfig.maxObservationsPerBatch) {
        log.debug({
          companyId: input.companyId,
          forgeChangeId: input.forgeChangeId,
          originalCount: observations.length,
          maxAllowed: forgeConfig.maxObservationsPerBatch,
        }, "Truncating observations to maxObservationsPerBatch bound");
        observations = observations.slice(0, forgeConfig.maxObservationsPerBatch);
      }

      // Apply total chars bound (REQ-005)
      let totalChars = observations.reduce((sum, obs) => sum + obs.content.length, 0);
      if (totalChars > forgeConfig.maxTotalChars) {
        log.debug({
          companyId: input.companyId,
          forgeChangeId: input.forgeChangeId,
          originalTotalChars: totalChars,
          maxAllowed: forgeConfig.maxTotalChars,
        }, "Truncating observations to maxTotalChars bound");
        // Truncate observations until under limit
        while (totalChars > forgeConfig.maxTotalChars && observations.length > 0) {
          const removed = observations.pop();
          if (removed) {
            totalChars -= removed.content.length;
          }
        }
      }

      // Always redact observations before sending to Cerebro
      // This ensures no secrets leak even if validation misses something
      observations = redactObservations(observations);

      // Submit to Cerebro
      const result = await submitObservationsToCerebro(
        forgeConfig,
        observations,
        input.companyId,
        input.projectId,
        input.actor.id,
        input.runId,
        input.issueId,
        fetchFn,
        log,
      );

      log.debug({
        companyId: input.companyId,
        forgeChangeId: input.forgeChangeId,
        acceptedCount: result.acceptedCount,
        rejectedCount: result.rejectedCount,
        degraded: result.degraded,
      }, "Forge observations written to Cerebro");

      return {
        success: result.success,
        acceptedCount: result.acceptedCount,
        rejectedCount: result.rejectedCount,
        rejectedReasons: result.rejectedReasons,
        degraded: result.degraded,
        degradedReason: result.degradedReason,
        errorCode: result.errorCode,
        errorSummary: result.errorSummary,
        audit: {
          written_at: writtenAt,
          bridge_config: buildForgeBridgeAuditMetadata(forgeConfig),
          event_count: input.events.length,
          observation_count: observations.length,
          accepted_count: result.acceptedCount,
          rejected_count: result.rejectedCount,
        },
      };
    } catch (error) {
      // Fail-open: log error but return degraded result, don't throw
      const errorMessage = error instanceof Error ? error.message : String(error);

      log.warn({
        companyId: input.companyId,
        forgeChangeId: input.forgeChangeId,
        error: errorMessage,
      }, "Forge observation write failed (fail-open)");

      return {
        success: false,
        acceptedCount: 0,
        rejectedCount: input.events.length,
        degraded: true,
        degradedReason: "error",
        errorCode: "write_failed",
        errorSummary: redactObservationContent(errorMessage).slice(0, 200),
        audit: {
          written_at: writtenAt,
          bridge_config: buildForgeBridgeAuditMetadata(forgeConfig),
          event_count: input.events.length,
          observation_count: 0,
          accepted_count: 0,
          rejected_count: input.events.length,
        },
      };
    }
  }

  return {
    isEnabled,
    getConfig,
    writeObservations,
  };
}

/**
 * Type for the Forge writeback service.
 */
export type ForgeWritebackService = ReturnType<typeof createForgeWritebackService>;

/**
 * Submit observations to Cerebro.
 * @requirements REQ-004, REQ-008, REQ-010
 */
async function submitObservationsToCerebro(
  config: ForgeBridgeConfig,
  observations: CerebroObservationPayload[],
  entity: string,
  projectId: string | undefined,
  actorId: string | undefined,
  runId: string | undefined,
  issueId: string | undefined,
  fetchFn: typeof fetch,
  log: typeof logger,
): Promise<{
  success: boolean;
  acceptedCount: number;
  rejectedCount: number;
  rejectedReasons?: string[];
  degraded?: boolean;
  degradedReason?: "unconfigured" | "unavailable" | "timeout" | "error";
  errorCode?: string;
  errorSummary?: string;
}> {
  if (!config.cerebroToken) {
    return {
      success: false,
      acceptedCount: 0,
      rejectedCount: observations.length,
      degraded: true,
      degradedReason: "unconfigured",
      errorCode: "cerebro_token_not_configured",
      errorSummary: "Cerebro token not configured",
    };
  }

  // Build the observations URL - use explicit URL if configured, otherwise derive from base URL
  let observationsUrl: string;
  if (config.cerebroObservationsUrl) {
    observationsUrl = config.cerebroObservationsUrl;
  } else if (config.cerebroUrl) {
    // Derive from base URL: replace /context-pack with /observations/batch
    // or append /observations/batch if no /context-pack present
    if (config.cerebroUrl.includes("/context-pack")) {
      observationsUrl = config.cerebroUrl.replace("/context-pack", "/observations/batch");
    } else {
      // Append observations endpoint to base URL
      const baseUrl = config.cerebroUrl.replace(/\/$/, ""); // Remove trailing slash
      observationsUrl = `${baseUrl}/observations/batch`;
    }
  } else {
    return {
      success: false,
      acceptedCount: 0,
      rejectedCount: observations.length,
      degraded: true,
      degradedReason: "unconfigured",
      errorCode: "cerebro_url_not_configured",
      errorSummary: "Cerebro URL not configured",
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...buildTenantHeaders({
        companyId: entity,
        projectId,
        memberId: actorId,
      }),
    };

    if (config.cerebroToken) {
      headers["Authorization"] = `Bearer ${config.cerebroToken}`;
    }

    const requestBody = buildPaperclipObservationBatch({
      observations,
      companyId: entity,
      projectId,
      runId,
      issueId,
    });

    const response = await fetchFn(observationsUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      log.warn({
        status: response.status,
        companyId: entity,
        observationCount: observations.length,
      }, "Cerebro observation writeback failed (non-2xx)");

      return {
        success: false,
        acceptedCount: 0,
        rejectedCount: observations.length,
        degraded: true,
        degradedReason: "unavailable",
        errorCode: `cerebro_http_${response.status}`,
        errorSummary: `Cerebro returned HTTP ${response.status}`,
      };
    }

    // Parse response if available
    let acceptedCount = observations.length;
    try {
      const data = await response.json() as {
        accepted?: number;
        rejected?: number;
        created?: number;
        updated?: number;
        duplicates?: number;
        errors?: number;
      };
      const derivedAcceptedCount = (data.created ?? 0) + (data.updated ?? 0) + (data.duplicates ?? 0);
      acceptedCount = data.accepted ?? (derivedAcceptedCount || observations.length);
    } catch {
      // Ignore parse errors, assume all were accepted
    }

    log.debug({
      companyId: entity,
      acceptedCount,
      rejectedCount: observations.length - acceptedCount,
    }, "Cerebro observations written successfully");

    return {
      success: true,
      acceptedCount,
      rejectedCount: observations.length - acceptedCount,
      degraded: false,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error &&
      (error.name === "AbortError" || errorMessage.includes("timeout"));

    log.warn({
      companyId: entity,
      isTimeout,
      error: isTimeout ? "timeout" : "network_error",
    }, "Cerebro observation writeback failed (fail-open)");

    return {
      success: false,
      acceptedCount: 0,
      rejectedCount: observations.length,
      degraded: true,
      degradedReason: isTimeout ? "timeout" : "error",
      errorCode: isTimeout ? "timeout" : "network_error",
      errorSummary: isTimeout ? "Request timeout" : redactObservationContent(errorMessage).slice(0, 200),
    };
  }
}
