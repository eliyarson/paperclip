/**
 * Cerebro Learning Surfaces Service
 *
 * Server-side service helper for Paperclip to proxy learning candidate
 * lifecycle operations to Cerebro with proper auth, validation, and redaction.
 *
 * Patterns reused from cerebro-context-client.ts:
 * - Server-side config with bearer token (never exposed to clients)
 * - Fail-open degraded state handling
 * - Secret redaction in all outputs
 * - Timeout and bounds enforcement
 * - Audit metadata for actions
 *
 * @checkpoint paperclip-cerebro-learning-surfaces-v0
 * @task TASK-003
 */

import type { Config } from "../config.js";
import { logger } from "../middleware/logger.js";
import { redactSensitiveText, REDACTED_EVENT_VALUE } from "../redaction.js";
import type {
  CerebroLearningCandidateListRequest,
  CerebroLearningCandidateListResponse,
  CerebroLearningCandidateDetailRequest,
  CerebroLearningCandidateDetailResponse,
  CerebroLearningCandidateActionRequest,
  CerebroLearningCandidateActionResponse,
  CerebroLearningDegradedState,
} from "@paperclipai/shared";

/**
 * Cerebro learning surfaces client configuration.
 */
export interface CerebroLearningClientConfig {
  /** Whether learning surfaces are enabled. */
  enabled: boolean;
  /** Cerebro base URL (e.g., http://localhost:8042). */
  baseUrl: string | undefined;
  /** Bearer token for authentication. */
  bearerToken: string | undefined;
  /** HTTP timeout in milliseconds. Default: 10000ms. */
  timeoutMs: number;
  /** Maximum items to request. Default: 100. */
  maxItems: number;
  /** Maximum chars per snippet. Default: 2000. */
  maxCharsPerSnippet: number;
}

/**
 * Dependencies for the learning client (for testing/DI).
 */
export interface LearningClientDeps {
  fetch: typeof fetch;
  now: () => Date;
  log: typeof logger;
}

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_MAX_CHARS_PER_SNIPPET = 2000;

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

/**
 * Convert camelCase object keys to snake_case.
 * Used for Paperclip -> Cerebro request conversion.
 */
function camelToSnake(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(camelToSnake);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    result[snakeKey] = camelToSnake(value);
  }
  return result;
}

/**
 * Convert snake_case object keys to camelCase.
 * Used for Cerebro -> Paperclip response conversion.
 */
function snakeToCamel(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(snakeToCamel);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    result[camelKey] = snakeToCamel(value);
  }
  return result;
}

/**
 * Parse Cerebro learning client configuration from environment and config.
 */
export function parseCerebroLearningClientConfig(
  _config: Config,
  env: NodeJS.ProcessEnv = process.env,
): CerebroLearningClientConfig {
  const baseUrl = env.PAPERCLIP_CEREBRO_URL?.trim() || undefined;
  const bearerToken = env.PAPERCLIP_CEREBRO_TOKEN?.trim() || undefined;
  const enabledFromEnv = env.PAPERCLIP_CEREBRO_LEARNING_ENABLED?.trim();

  // Default: enabled only if URL is configured
  const enabled = enabledFromEnv !== undefined
    ? enabledFromEnv === "true"
    : !!baseUrl;

  const timeoutMs = Math.max(
    1000,
    Math.min(
      60000,
      Number(env.PAPERCLIP_CEREBRO_LEARNING_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    ),
  );

  const maxItems = Math.max(
    1,
    Math.min(
      100,
      Number(env.PAPERCLIP_CEREBRO_LEARNING_MAX_ITEMS) || DEFAULT_MAX_ITEMS,
    ),
  );

  const maxCharsPerSnippet = Math.max(
    100,
    Math.min(
      5000,
      Number(env.PAPERCLIP_CEREBRO_LEARNING_MAX_CHARS) || DEFAULT_MAX_CHARS_PER_SNIPPET,
    ),
  );

  return {
    enabled,
    baseUrl,
    bearerToken,
    timeoutMs,
    maxItems,
    maxCharsPerSnippet,
  };
}

/**
 * Build a degraded response for fail-open behavior.
 */
function buildDegradedListResponse(
  reason: CerebroLearningDegradedState["reason"],
  message: string,
  request: CerebroLearningCandidateListRequest,
): CerebroLearningCandidateListResponse {
  return {
    success: false,
    candidates: [],
    total: 0,
    limit: request.limit,
    offset: request.offset,
    degraded: {
      isDegraded: true,
      reason,
      message,
      detectedAt: new Date().toISOString(),
    },
    errorCode: "degraded",
    errorSummary: message,
  };
}

/**
 * Build a degraded detail response.
 */
function buildDegradedDetailResponse(
  reason: CerebroLearningDegradedState["reason"],
  message: string,
): CerebroLearningCandidateDetailResponse {
  return {
    success: false,
    degraded: {
      isDegraded: true,
      reason,
      message,
      detectedAt: new Date().toISOString(),
    },
    errorCode: "degraded",
    errorSummary: message,
  };
}

/**
 * Build a degraded action response.
 */
function buildDegradedActionResponse(
  reason: CerebroLearningDegradedState["reason"],
  message: string,
): CerebroLearningCandidateActionResponse {
  return {
    success: false,
    degraded: {
      isDegraded: true,
      reason,
      message,
      detectedAt: new Date().toISOString(),
    },
    errorCode: "degraded",
    errorSummary: message,
  };
}

/**
 * Redact secrets from response data.
 */
function redactResponseData<T>(data: T): T {
  const json = JSON.stringify(data);
  const redacted = redactSensitiveText(json);
  return JSON.parse(redacted) as T;
}

/**
 * Build Cerebro API URL for an endpoint.
 */
function buildCerebroUrl(baseUrl: string, endpoint: string): string {
  // Remove trailing slash from baseUrl
  const base = baseUrl.replace(/\/$/, "");
  // Ensure endpoint starts with /
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${base}${path}`;
}

function normalizeSortByForCerebro(sortBy: CerebroLearningCandidateListRequest["sortBy"]): string {
  if (sortBy === "createdAt") return "created_at";
  if (sortBy === "updatedAt") return "updated_at";
  return sortBy;
}

/**
 * Fetch learning candidates list from Cerebro.
 * Fail-open: returns degraded result on error/timeout/unavailable.
 */
export async function fetchLearningCandidatesList(
  config: CerebroLearningClientConfig,
  request: CerebroLearningCandidateListRequest,
  deps: LearningClientDeps,
): Promise<CerebroLearningCandidateListResponse> {
  // Return degraded result if not configured
  if (!config.enabled || !config.baseUrl) {
    return buildDegradedListResponse(
      "cerebro_unavailable",
      "Cerebro learning surfaces not configured",
      request,
    );
  }

  // Validate bounds
  const boundedRequest = {
    ...request,
    limit: Math.min(request.limit, config.maxItems),
    sortBy: normalizeSortByForCerebro(request.sortBy),
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...buildTenantHeaders({
        companyId: request.companyId,
        projectId: request.projectId,
      }),
    };

    if (config.bearerToken) {
      headers["Authorization"] = `Bearer ${config.bearerToken}`;
    }

    const url = buildCerebroUrl(config.baseUrl, "/paperclip/learning-candidates/list");

    deps.log.debug({
      companyId: request.companyId,
      action: "list",
    }, "Fetching learning candidates from Cerebro");

    const response = await deps.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(camelToSnake(boundedRequest)),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      deps.log.warn({
        status: response.status,
        companyId: request.companyId,
      }, "Cerebro learning candidates list failed (non-2xx)");

      return buildDegradedListResponse(
        "cerebro_unavailable",
        `Cerebro returned ${response.status}`,
        request,
      );
    }

    const rawData = await response.json();
    const data = snakeToCamel(rawData) as CerebroLearningCandidateListResponse;

    // Redact and return
    return redactResponseData(data);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error &&
      (error.name === "AbortError" || errorMessage.includes("timeout"));

    deps.log.warn({
      companyId: request.companyId,
      isTimeout,
      error: isTimeout ? "timeout" : "network_error",
    }, "Cerebro learning candidates list failed (fail-open)");

    return buildDegradedListResponse(
      isTimeout ? "timeout" : "cerebro_unavailable",
      isTimeout ? "Request timeout" : "Network error",
      request,
    );
  }
}

/**
 * Fetch learning candidate detail from Cerebro.
 * Fail-open: returns degraded result on error/timeout/unavailable.
 */
export async function fetchLearningCandidateDetail(
  config: CerebroLearningClientConfig,
  request: CerebroLearningCandidateDetailRequest,
  deps: LearningClientDeps,
): Promise<CerebroLearningCandidateDetailResponse> {
  // Return degraded result if not configured
  if (!config.enabled || !config.baseUrl) {
    return buildDegradedDetailResponse(
      "cerebro_unavailable",
      "Cerebro learning surfaces not configured",
    );
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...buildTenantHeaders({
        companyId: request.companyId,
      }),
    };

    if (config.bearerToken) {
      headers["Authorization"] = `Bearer ${config.bearerToken}`;
    }

    const url = buildCerebroUrl(config.baseUrl, "/paperclip/learning-candidates/detail");

    deps.log.debug({
      candidateId: request.candidateId,
      companyId: request.companyId,
      action: "detail",
    }, "Fetching learning candidate detail from Cerebro");

    const response = await deps.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(camelToSnake(request)),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      deps.log.warn({
        status: response.status,
        candidateId: request.candidateId,
      }, "Cerebro learning candidate detail failed (non-2xx)");

      return buildDegradedDetailResponse(
        "cerebro_unavailable",
        `Cerebro returned ${response.status}`,
      );
    }

    const rawData = await response.json();
    const data = snakeToCamel(rawData) as CerebroLearningCandidateDetailResponse;

    // Redact and return
    return redactResponseData(data);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error &&
      (error.name === "AbortError" || errorMessage.includes("timeout"));

    deps.log.warn({
      candidateId: request.candidateId,
      isTimeout,
      error: isTimeout ? "timeout" : "network_error",
    }, "Cerebro learning candidate detail failed (fail-open)");

    return buildDegradedDetailResponse(
      isTimeout ? "timeout" : "cerebro_unavailable",
      isTimeout ? "Request timeout" : "Network error",
    );
  }
}

/**
 * Perform action on learning candidate via Cerebro.
 * Fail-safely: returns degraded result on error (mutations should not pretend success).
 */
export async function performLearningCandidateAction(
  config: CerebroLearningClientConfig,
  request: CerebroLearningCandidateActionRequest,
  actorId: string,
  deps: LearningClientDeps,
): Promise<CerebroLearningCandidateActionResponse> {
  // Return degraded result if not configured
  if (!config.enabled || !config.baseUrl) {
    return buildDegradedActionResponse(
      "cerebro_unavailable",
      "Cerebro learning surfaces not configured",
    );
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...buildTenantHeaders({
        companyId: request.companyId,
        memberId: actorId,
      }),
    };

    if (config.bearerToken) {
      headers["Authorization"] = `Bearer ${config.bearerToken}`;
    }

    const url = buildCerebroUrl(config.baseUrl, "/paperclip/learning-candidates/action");

    deps.log.info({
      candidateId: request.candidateId,
      companyId: request.companyId,
      action: request.action,
      actorId,
    }, "Performing learning candidate action via Cerebro");

    const response = await deps.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(camelToSnake(request)),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      deps.log.warn({
        status: response.status,
        candidateId: request.candidateId,
        action: request.action,
      }, "Cerebro learning candidate action failed (non-2xx)");

      return buildDegradedActionResponse(
        "cerebro_unavailable",
        `Cerebro returned ${response.status}`,
      );
    }

    const rawData = await response.json();
    const data = snakeToCamel(rawData) as CerebroLearningCandidateActionResponse;

    // Redact and return
    return redactResponseData(data);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error &&
      (error.name === "AbortError" || errorMessage.includes("timeout"));

    deps.log.warn({
      candidateId: request.candidateId,
      action: request.action,
      isTimeout,
      error: isTimeout ? "timeout" : "network_error",
    }, "Cerebro learning candidate action failed (fail-safe)");

    return buildDegradedActionResponse(
      isTimeout ? "timeout" : "cerebro_unavailable",
      isTimeout ? "Request timeout" : "Network error",
    );
  }
}

/**
 * Cerebro learning surfaces client interface.
 */
export interface CerebroLearningClient {
  /**
   * List learning candidates (company-scoped).
   * Fail-open: returns degraded result on error/timeout/unavailable.
   */
  listCandidates(request: CerebroLearningCandidateListRequest): Promise<CerebroLearningCandidateListResponse>;

  /**
   * Get candidate detail.
   * Fail-open: returns degraded result on error/timeout/unavailable.
   */
  getCandidateDetail(request: CerebroLearningCandidateDetailRequest): Promise<CerebroLearningCandidateDetailResponse>;

  /**
   * Perform action on candidate (promote/dismiss/supersede).
   * Fail-safely: returns degraded result on error.
   */
  performAction(
    request: CerebroLearningCandidateActionRequest,
    actorId: string,
  ): Promise<CerebroLearningCandidateActionResponse>;

  /**
   * Check if learning surfaces are enabled.
   */
  isEnabled(): boolean;

  /**
   * Get client configuration (for audit/metadata).
   * Secrets are redacted.
   */
  getConfig(): Omit<CerebroLearningClientConfig, "bearerToken"> & { bearerToken: typeof REDACTED_EVENT_VALUE | undefined };
}

/**
 * Create a no-op learning client (when disabled).
 */
function createNoopLearningClient(config: CerebroLearningClientConfig): CerebroLearningClient {
  return {
    async listCandidates(request: CerebroLearningCandidateListRequest) {
      return buildDegradedListResponse(
        "cerebro_unavailable",
        "Cerebro learning surfaces not configured",
        request,
      );
    },
    async getCandidateDetail(_request: CerebroLearningCandidateDetailRequest) {
      return buildDegradedDetailResponse(
        "cerebro_unavailable",
        "Cerebro learning surfaces not configured",
      );
    },
    async performAction(
      _request: CerebroLearningCandidateActionRequest,
      _actorId: string,
    ) {
      return buildDegradedActionResponse(
        "cerebro_unavailable",
        "Cerebro learning surfaces not configured",
      );
    },
    isEnabled: () => false,
    getConfig: () => ({
      ...config,
      bearerToken: config.bearerToken ? REDACTED_EVENT_VALUE : undefined,
    }),
  };
}

/**
 * Create a real learning client.
 */
function createRealLearningClient(
  config: CerebroLearningClientConfig,
  deps: LearningClientDeps,
): CerebroLearningClient {
  return {
    async listCandidates(request: CerebroLearningCandidateListRequest) {
      return fetchLearningCandidatesList(config, request, deps);
    },
    async getCandidateDetail(request: CerebroLearningCandidateDetailRequest) {
      return fetchLearningCandidateDetail(config, request, deps);
    },
    async performAction(
      request: CerebroLearningCandidateActionRequest,
      actorId: string,
    ) {
      return performLearningCandidateAction(config, request, actorId, deps);
    },
    isEnabled: () => true,
    getConfig: () => ({
      ...config,
      bearerToken: config.bearerToken ? REDACTED_EVENT_VALUE : undefined,
    }),
  };
}

/**
 * Create the Cerebro learning surfaces client.
 * Returns a no-op client if not configured or disabled.
 */
export function createCerebroLearningClient(
  config: CerebroLearningClientConfig,
  deps: LearningClientDeps = {
    fetch: globalThis.fetch,
    now: () => new Date(),
    log: logger,
  },
): CerebroLearningClient {
  if (!config.enabled || !config.baseUrl) {
    return createNoopLearningClient(config);
  }
  return createRealLearningClient(config, deps);
}
