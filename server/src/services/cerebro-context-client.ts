import type { Config } from "../config.js";
import { logger } from "../middleware/logger.js";
import { redactSensitiveText, REDACTED_EVENT_VALUE } from "../redaction.js";
import type { CerebroObservation, CerebroObservationBatch } from "@paperclipai/shared";

/**
 * Cerebro context client configuration.
 * Parsed from environment variables or config object.
 */
export interface CerebroContextClientConfig {
  /** Whether context fetching is enabled. Default: false when no URL configured. */
  enabled: boolean;
  /** Cerebro context-pack endpoint URL. */
  contextUrl: string | undefined;
  /** Bearer token for authentication. */
  bearerToken: string | undefined;
  /** HTTP timeout in milliseconds. Default: 5000ms. */
  timeoutMs: number;
  /** Maximum items to request from Cerebro. Default: 20. */
  maxItems: number;
  /** Maximum characters per context item. Default: 8000. */
  maxCharsPerItem: number;
  /** Maximum total characters for context pack. Default: 50000. */
  maxTotalChars: number;
}

/**
 * Context pack item from Cerebro.
 */
export interface ContextPackItem {
  id: string;
  source_type: string;
  source_id: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Context pack response from Cerebro.
 */
export interface ContextPack {
  items: ContextPackItem[];
  query: string;
  total_available: number;
  truncated: boolean;
}

/**
 * Degraded context result when Cerebro is unavailable or unconfigured.
 */
export interface DegradedContextPack {
  degraded: true;
  reason: "unconfigured" | "unavailable" | "timeout" | "error";
  items: [];
  query: string;
  total_available: 0;
  truncated: false;
}

/**
 * Result of a context fetch attempt.
 */
export type ContextFetchResult = ContextPack | DegradedContextPack;

/**
 * Worker mode for context query shaping.
 */
export type WorkerMode = "run" | "hire";

/**
 * Worker role for context query shaping.
 */
export type WorkerRole = "pm" | "developer" | "default";

/**
 * Input for building a context query.
 */
export interface BuildContextQueryInput {
  /** Company/tenant identifier. */
  companyId: string;
  /** Project identifier (optional). */
  projectId?: string;
  /** Issue identifier (optional). */
  issueId?: string;
  /** Run identifier (optional). */
  runId?: string;
  /** Agent identifier (optional). */
  agentId?: string;
  /** Worker mode: run or hire. */
  mode: WorkerMode;
  /** Worker role: pm, developer, or default. */
  role: WorkerRole;
  /** Additional context tags (optional). */
  tags?: string[];
}

/**
 * Dependencies for the context client (for testing/DI).
 */
export interface ContextClientDeps {
  fetch: typeof fetch;
  now: () => Date;
  log: typeof logger;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_MAX_CHARS_PER_ITEM = 8000;
const DEFAULT_MAX_TOTAL_CHARS = 50000;

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
 * Parse Cerebro context client configuration from environment and config.
 */
export function parseCerebroContextClientConfig(
  _config: Config,
  env: NodeJS.ProcessEnv = process.env,
): CerebroContextClientConfig {
  const contextUrl = env.PAPERCLIP_CEREBRO_CONTEXT_URL?.trim() || undefined;
  const bearerToken = env.PAPERCLIP_CEREBRO_CONTEXT_TOKEN?.trim() || undefined;
  const enabledFromEnv = env.PAPERCLIP_CEREBRO_CONTEXT_ENABLED?.trim();

  // Default: enabled only if URL is configured
  const enabled = enabledFromEnv !== undefined
    ? enabledFromEnv === "true"
    : !!contextUrl;

  const timeoutMs = Math.max(
    1000,
    Math.min(
      30000,
      Number(env.PAPERCLIP_CEREBRO_CONTEXT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    ),
  );

  const maxItems = Math.max(
    1,
    Math.min(
      100,
      Number(env.PAPERCLIP_CEREBRO_CONTEXT_MAX_ITEMS) || DEFAULT_MAX_ITEMS,
    ),
  );

  const maxCharsPerItem = Math.max(
    100,
    Math.min(
      50000,
      Number(env.PAPERCLIP_CEREBRO_CONTEXT_MAX_CHARS) || DEFAULT_MAX_CHARS_PER_ITEM,
    ),
  );

  const maxTotalChars = Math.max(
    1000,
    Math.min(
      200000,
      Number(env.PAPERCLIP_CEREBRO_CONTEXT_MAX_TOTAL_CHARS) || DEFAULT_MAX_TOTAL_CHARS,
    ),
  );

  return {
    enabled,
    contextUrl,
    bearerToken,
    timeoutMs,
    maxItems,
    maxCharsPerItem,
    maxTotalChars,
  };
}

/**
 * Build PM-specific query text for project management context.
 * Covers: project learnings, roadmap, decisions, blockers, preferences, playbooks, outcomes, evidence summaries.
 */
function buildPmQueryText(input: BuildContextQueryInput): string {
  const parts: string[] = [
    `Project context for ${input.mode === "hire" ? "onboarding" : "execution"}`,
  ];

  if (input.projectId) {
    parts.push(`Project: ${input.projectId}`);
  }
  if (input.issueId) {
    parts.push(`Issue: ${input.issueId}`);
  }

  parts.push("Focus areas:");
  parts.push("- Project learnings and historical decisions");
  parts.push("- Roadmap and strategic direction");
  parts.push("- Active blockers and dependencies");
  parts.push("- Team preferences and conventions");
  parts.push("- Playbooks and established patterns");
  parts.push("- Outcomes and results from prior work");
  parts.push("- Evidence summaries and supporting data");

  if (input.tags && input.tags.length > 0) {
    parts.push(`Tags: ${input.tags.join(", ")}`);
  }

  return parts.join("\n");
}

/**
 * Build developer-specific query text for technical execution context.
 */
function buildDeveloperQueryText(input: BuildContextQueryInput): string {
  const parts: string[] = [
    `Technical context for ${input.mode === "hire" ? "onboarding" : "execution"}`,
  ];

  if (input.projectId) {
    parts.push(`Project: ${input.projectId}`);
  }
  if (input.issueId) {
    parts.push(`Issue: ${input.issueId}`);
  }
  if (input.runId) {
    parts.push(`Run: ${input.runId}`);
  }

  parts.push("Focus areas:");
  parts.push("- Technical decisions and architecture");
  parts.push("- Code patterns and conventions");
  parts.push("- Related implementations and examples");
  parts.push("- Known issues and workarounds");

  if (input.tags && input.tags.length > 0) {
    parts.push(`Tags: ${input.tags.join(", ")}`);
  }

  return parts.join("\n");
}

/**
 * Build default query text for general context.
 */
function buildDefaultQueryText(input: BuildContextQueryInput): string {
  const parts: string[] = [
    `Context for ${input.mode === "hire" ? "onboarding" : "execution"}`,
  ];

  if (input.projectId) {
    parts.push(`Project: ${input.projectId}`);
  }
  if (input.issueId) {
    parts.push(`Issue: ${input.issueId}`);
  }
  if (input.runId) {
    parts.push(`Run: ${input.runId}`);
  }

  parts.push("Relevant project history and decisions");

  if (input.tags && input.tags.length > 0) {
    parts.push(`Tags: ${input.tags.join(", ")}`);
  }

  return parts.join("\n");
}

/**
 * Build role-aware query text based on worker role.
 */
export function buildRoleAwareQueryText(input: BuildContextQueryInput): string {
  switch (input.role) {
    case "pm":
      return buildPmQueryText(input);
    case "developer":
      return buildDeveloperQueryText(input);
    default:
      return buildDefaultQueryText(input);
  }
}

/**
 * Build query tags based on input parameters.
 */
export function buildContextQueryTags(input: BuildContextQueryInput): string[] {
  const tags: string[] = [
    `mode:${input.mode}`,
    `role:${input.role}`,
  ];

  if (input.companyId) {
    tags.push(`company:${input.companyId}`);
  }
  if (input.projectId) {
    tags.push(`project:${input.projectId}`);
  }
  if (input.issueId) {
    tags.push(`issue:${input.issueId}`);
  }
  if (input.runId) {
    tags.push(`run:${input.runId}`);
  }
  if (input.agentId) {
    tags.push(`agent:${input.agentId}`);
  }
  if (input.tags) {
    tags.push(...input.tags);
  }

  return tags;
}

/**
 * Build the complete context query payload for Cerebro.
 */
export interface ContextQueryPayload {
  company_id: string;
  project_id: string;
  change_id?: string;
  run_id?: string;
  query: string;
  tags: string[];
  entity: string;
  k: number;
  max_items: number;
  max_chars: number;
  max_chars_per_item: number;
  max_total_chars: number;
}

export function buildContextQueryPayload(
  input: BuildContextQueryInput,
  config: CerebroContextClientConfig,
): ContextQueryPayload {
  const query = buildRoleAwareQueryText(input);
  const tags = buildContextQueryTags(input);

  return {
    company_id: input.companyId,
    project_id: input.projectId || "default",
    change_id: input.issueId,
    run_id: input.runId,
    query,
    tags,
    entity: input.companyId,
    k: config.maxItems,
    max_items: config.maxItems,
    max_chars: config.maxTotalChars,
    max_chars_per_item: config.maxCharsPerItem,
    max_total_chars: config.maxTotalChars,
  };
}

/**
 * Redact secrets from context pack items.
 */
function redactContextPackItems(items: ContextPackItem[]): ContextPackItem[] {
  return items.map((item) => ({
    ...item,
    content: redactSensitiveText(item.content),
    metadata: item.metadata ? JSON.parse(redactSensitiveText(JSON.stringify(item.metadata))) as Record<string, unknown> : undefined,
  }));
}

/**
 * Fetch context pack from Cerebro.
 * Fail-open: returns degraded result on error/timeout/unavailable.
 */
export async function fetchContextPack(
  config: CerebroContextClientConfig,
  input: BuildContextQueryInput,
  deps: ContextClientDeps,
): Promise<ContextFetchResult> {
  // Return degraded result if not configured
  if (!config.enabled || !config.contextUrl) {
    return {
      degraded: true,
      reason: "unconfigured",
      items: [],
      query: buildRoleAwareQueryText(input),
      total_available: 0,
      truncated: false,
    };
  }

  const payload = buildContextQueryPayload(input, config);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...buildTenantHeaders({
        companyId: input.companyId,
        projectId: input.projectId,
        memberId: input.agentId,
      }),
    };

    if (config.bearerToken) {
      headers["Authorization"] = `Bearer ${config.bearerToken}`;
    }

    const response = await deps.fetch(config.contextUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      deps.log.warn({
        status: response.status,
        companyId: input.companyId,
        mode: input.mode,
        role: input.role,
      }, "Cerebro context fetch failed (non-2xx)");

      return {
        degraded: true,
        reason: "unavailable",
        items: [],
        query: payload.query,
        total_available: 0,
        truncated: false,
      };
    }

    const data = await response.json() as ContextPack & {
      budget?: { used_items?: number; max_items?: number };
    };
    const rawItems = (data.items || []) as Array<ContextPackItem & {
      preview?: string;
      created_at?: string;
    }>;

    // Validate and redact the response
    const validatedPack: ContextPack = {
      items: redactContextPackItems(rawItems.map((item) => ({
        ...item,
        content: item.content ?? item.preview ?? "",
        timestamp: item.timestamp ?? item.created_at ?? "",
      }))),
      query: payload.query,
      total_available: Math.max(0, data.total_available || data.budget?.used_items || 0),
      truncated: !!data.truncated || (
        typeof data.budget?.used_items === "number"
        && typeof data.budget?.max_items === "number"
        && data.budget.used_items >= data.budget.max_items
      ),
    };

    deps.log.debug({
      companyId: input.companyId,
      mode: input.mode,
      role: input.role,
      itemCount: validatedPack.items.length,
      totalAvailable: validatedPack.total_available,
    }, "Cerebro context fetched successfully");

    return validatedPack;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error &&
      (error.name === "AbortError" || errorMessage.includes("timeout"));

    deps.log.warn({
      companyId: input.companyId,
      mode: input.mode,
      role: input.role,
      isTimeout,
      error: isTimeout ? "timeout" : "network_error",
    }, "Cerebro context fetch failed (fail-open)");

    return {
      degraded: true,
      reason: isTimeout ? "timeout" : "error",
      items: [],
      query: payload.query,
      total_available: 0,
      truncated: false,
    };
  }
}

/**
 * Cerebro context client interface.
 */
export interface CerebroContextClient {
  /**
   * Fetch bounded context pack for a worker.
   * Fail-open: returns degraded result on error/timeout/unavailable.
   */
  fetchContext(input: BuildContextQueryInput): Promise<ContextFetchResult>;

  /**
   * Write observations back to Cerebro.
   * Validates taxonomy and redacts secrets before sending.
   * Fail-open: returns degraded result on error/timeout/unavailable.
   */
  writeObservations(payload: CerebroObservationBatchPayload): Promise<ObservationWritebackResult>;

  /**
   * Check if context fetching is enabled.
   */
  isEnabled(): boolean;

  /**
   * Get client configuration (for audit/metadata).
   * Secrets are redacted.
   */
  getConfig(): Omit<CerebroContextClientConfig, "bearerToken"> & { bearerToken: typeof REDACTED_EVENT_VALUE | undefined };
}

/**
 * Create a no-op context client (when disabled).
 */
function createNoopContextClient(config: CerebroContextClientConfig): CerebroContextClient {
  return {
    async fetchContext(input: BuildContextQueryInput): Promise<ContextFetchResult> {
      return {
        degraded: true,
        reason: "unconfigured",
        items: [],
        query: buildRoleAwareQueryText(input),
        total_available: 0,
        truncated: false,
      };
    },
    async writeObservations(payload: CerebroObservationBatchPayload): Promise<ObservationWritebackResult> {
      return {
        success: false,
        acceptedCount: 0,
        rejectedCount: payload.observations.length,
        rejectedReasons: ["Cerebro context client not configured"],
        degraded: true,
        degradedReason: "unconfigured",
      };
    },
    isEnabled: () => false,
    getConfig: () => ({
      ...config,
      bearerToken: config.bearerToken ? REDACTED_EVENT_VALUE : undefined,
    }),
  };
}

/**
 * Create a real context client.
 */
function createRealContextClient(
  config: CerebroContextClientConfig,
  deps: ContextClientDeps,
): CerebroContextClient {
  return {
    async fetchContext(input: BuildContextQueryInput): Promise<ContextFetchResult> {
      return fetchContextPack(config, input, deps);
    },
    async writeObservations(payload: CerebroObservationBatchPayload): Promise<ObservationWritebackResult> {
      return writeObservationsToCerebro(config, payload, deps);
    },
    isEnabled: () => true,
    getConfig: () => ({
      ...config,
      bearerToken: config.bearerToken ? REDACTED_EVENT_VALUE : undefined,
    }),
  };
}

/**
 * Create the Cerebro context client service.
 * Returns a no-op client if not configured or disabled.
 */
export function createCerebroContextClient(
  config: CerebroContextClientConfig,
  deps: ContextClientDeps = {
    fetch: globalThis.fetch,
    now: () => new Date(),
    log: logger,
  },
): CerebroContextClient {
  if (!config.enabled || !config.contextUrl) {
    return createNoopContextClient(config);
  }
  return createRealContextClient(config, deps);
}

/**
 * Build audit metadata for context injection without exposing secrets.
 */
export interface ContextAuditMetadata {
  fetched_at: string;
  query_shape: string;
  mode: WorkerMode;
  role: WorkerRole;
  item_count: number;
  total_available: number;
  truncated: boolean;
  degraded: boolean;
  degraded_reason?: string;
  budget: {
    max_items: number;
    max_chars_per_item: number;
    max_total_chars: number;
  };
}

export function buildContextAuditMetadata(
  result: ContextFetchResult,
  input: BuildContextQueryInput,
  config: CerebroContextClientConfig,
): ContextAuditMetadata {
  const isDegraded = "degraded" in result && result.degraded;

  return {
    fetched_at: new Date().toISOString(),
    query_shape: input.role,
    mode: input.mode,
    role: input.role,
    item_count: result.items.length,
    total_available: result.total_available,
    truncated: result.truncated,
    degraded: isDegraded,
    degraded_reason: isDegraded ? result.reason : undefined,
    budget: {
      max_items: config.maxItems,
      max_chars_per_item: config.maxCharsPerItem,
      max_total_chars: config.maxTotalChars,
    },
  };
}

/**
 * Convenience constants for worker modes.
 */
export const WORKER_MODES = {
  RUN: "run" as const,
  HIRE: "hire" as const,
};

/**
 * Convenience constants for worker roles.
 */
export const WORKER_ROLES = {
  PM: "pm" as const,
  DEVELOPER: "developer" as const,
  DEFAULT: "default" as const,
};

/**
 * Valid Cerebro observation taxonomy types.
 */
export const CEREBRO_OBSERVATION_TYPES = [
  "decision",
  "blocker",
  "gotcha",
  "playbook",
  "outcome",
  "preference",
  "evidence_summary",
] as const;

export type CerebroObservationType = typeof CEREBRO_OBSERVATION_TYPES[number];

/**
 * Single observation payload for Cerebro.
 */
export interface CerebroObservationPayload {
  type: CerebroObservationType;
  content: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Batch observation payload for Cerebro.
 */
export interface CerebroObservationBatchPayload {
  observations: CerebroObservationPayload[];
  entity: string;
  run_id?: string;
  issue_id?: string;
}

/**
 * Result of an observation writeback attempt.
 */
export interface ObservationWritebackResult {
  success: boolean;
  acceptedCount: number;
  rejectedCount: number;
  rejectedReasons?: string[];
  degraded?: boolean;
  degradedReason?: string;
}

/**
 * Secret/redaction patterns for observation content validation.
 */
const SUSPICIOUS_PATTERNS = [
  /bearer\s+[a-zA-Z0-9_\-\.]+/i,
  /token\s*[=:]\s*[a-zA-Z0-9_\-\.]{10,}/i,
  /api[_-]?key\s*[=:]\s*[a-zA-Z0-9_\-\.]{10,}/i,
  /password\s*[=:]\s*\S+/i,
  /secret\s*[=:]\s*\S+/i,
  /sk-[a-zA-Z0-9]{20,}/i,
  /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/i, // JWT pattern
];

/**
 * Validate a single observation for secrets and taxonomy compliance.
 * Returns null if valid, error message if invalid.
 */
function validateObservation(obs: CerebroObservationPayload): string | null {
  // Validate taxonomy
  if (!CEREBRO_OBSERVATION_TYPES.includes(obs.type)) {
    return `Invalid observation type: ${obs.type}. Must be one of: ${CEREBRO_OBSERVATION_TYPES.join(", ")}`;
  }

  // Check for empty content
  if (!obs.content || obs.content.trim().length === 0) {
    return "Observation content cannot be empty";
  }

  // Check for suspicious patterns (potential secrets)
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(obs.content)) {
      return `Observation content contains potential secret pattern matching: ${pattern.source}`;
    }
  }

  // Check metadata for secrets
  if (obs.metadata) {
    const metadataStr = JSON.stringify(obs.metadata);
    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (pattern.test(metadataStr)) {
        return "Observation metadata contains potential secret pattern";
      }
    }
  }

  return null;
}

/**
 * Redact secrets from observation content.
 */
function redactObservationContent(content: string): string {
  return redactSensitiveText(content);
}

/**
 * Write observations back to Cerebro.
 * Validates taxonomy and redacts secrets before sending.
 * Fail-open: returns degraded result on error/timeout/unavailable.
 */
export async function writeObservationsToCerebro(
  config: CerebroContextClientConfig,
  payload: CerebroObservationBatchPayload,
  deps: ContextClientDeps,
): Promise<ObservationWritebackResult> {
  // Return degraded result if not configured
  if (!config.enabled || !config.contextUrl) {
    return {
      success: false,
      acceptedCount: 0,
      rejectedCount: payload.observations.length,
      rejectedReasons: ["Cerebro context client not configured"],
      degraded: true,
      degradedReason: "unconfigured",
    };
  }

  // Validate and filter observations
  const validObservations: CerebroObservationPayload[] = [];
  const rejectedReasons: string[] = [];

  for (const obs of payload.observations) {
    const validationError = validateObservation(obs);
    if (validationError) {
      rejectedReasons.push(`[${obs.type}] ${validationError}`);
    } else {
      // Redact before sending
      validObservations.push({
        ...obs,
        content: redactObservationContent(obs.content),
        metadata: obs.metadata ? JSON.parse(redactSensitiveText(JSON.stringify(obs.metadata))) as Record<string, unknown> : undefined,
      });
    }
  }

  // If all observations were rejected, return early
  if (validObservations.length === 0) {
    return {
      success: false,
      acceptedCount: 0,
      rejectedCount: payload.observations.length,
      rejectedReasons,
      degraded: false,
    };
  }

  // Build the observations URL from context URL
  const observationsUrl = config.contextUrl.replace("/context-pack", "/observations/batch");

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...buildTenantHeaders({
        companyId: payload.entity,
        memberId: payload.run_id,
      }),
    };

    if (config.bearerToken) {
      headers["Authorization"] = `Bearer ${config.bearerToken}`;
    }

    const requestBody = {
      observations: validObservations,
      entity: payload.entity,
      run_id: payload.run_id,
      issue_id: payload.issue_id,
    };

    const response = await deps.fetch(observationsUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      deps.log.warn({
        status: response.status,
        companyId: payload.entity,
        observationCount: validObservations.length,
      }, "Cerebro observation writeback failed (non-2xx)");

      return {
        success: false,
        acceptedCount: 0,
        rejectedCount: payload.observations.length,
        rejectedReasons: [`Cerebro returned ${response.status}`],
        degraded: true,
        degradedReason: "unavailable",
      };
    }

    // Parse response if available
    let acceptedCount = validObservations.length;
    try {
      const data = await response.json() as { accepted?: number; rejected?: number };
      acceptedCount = data.accepted ?? validObservations.length;
    } catch {
      // Ignore parse errors, assume all were accepted
    }

    deps.log.debug({
      companyId: payload.entity,
      acceptedCount,
      rejectedCount: payload.observations.length - acceptedCount,
    }, "Cerebro observations written successfully");

    return {
      success: true,
      acceptedCount,
      rejectedCount: payload.observations.length - acceptedCount,
      rejectedReasons: rejectedReasons.length > 0 ? rejectedReasons : undefined,
      degraded: false,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error &&
      (error.name === "AbortError" || errorMessage.includes("timeout"));

    deps.log.warn({
      companyId: payload.entity,
      isTimeout,
      error: isTimeout ? "timeout" : "network_error",
    }, "Cerebro observation writeback failed (fail-open)");

    return {
      success: false,
      acceptedCount: 0,
      rejectedCount: payload.observations.length,
      rejectedReasons: [isTimeout ? "Request timeout" : "Network error"],
      degraded: true,
      degradedReason: isTimeout ? "timeout" : "error",
    };
  }
}
