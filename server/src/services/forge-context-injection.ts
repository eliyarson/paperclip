/**
 * Forge Context Injection Service
 *
 * Server-mediated Forge context injection path that uses Paperclip server-held
 * Cerebro credentials and existing context client conventions.
 *
 * Fetches bounded context for Forge scope and injects advisory/redacted context
 * plus degraded metadata. Disabled/unconfigured/no-op by default.
 *
 * @checkpoint paperclip-forge-cerebro-memory-bridge-v0
 * @requirements REQ-003, REQ-005, REQ-007, REQ-008, REQ-009, REQ-010, REQ-011
 */

import type { Config } from "../config.js";
import { logger } from "../middleware/logger.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import {
  createCerebroContextClient,
  parseCerebroContextClientConfig,
  buildRoleAwareQueryText,
  buildContextQueryTags,
  type BuildContextQueryInput,
  type ContextFetchResult,
  type CerebroContextClient,
} from "./cerebro-context-client.js";
import {
  parseForgeBridgeConfig,
  isForgeBridgeEnabled,
  buildForgeBridgeAuditMetadata,
  type ForgeBridgeConfig,
} from "./forge-bridge-config.js";

/**
 * Input for fetching Forge context.
 * @requirements REQ-005 - preserves all scope identifiers
 */
export interface FetchForgeContextInput {
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

  /** Forge worker_id (optional) */
  forgeWorkerId?: string;

  /** Forge task_id (optional) */
  forgeTaskId?: string;

  /** Worker mode for query shaping */
  mode: "run" | "hire";

  /** Worker role for query shaping */
  role: "pm" | "developer" | "default";

  /** Additional context tags (optional) */
  tags?: string[];
}

/**
 * Forge context result with advisory metadata.
 * @requirements REQ-008 - fail-open with degraded metadata
 */
export interface ForgeContextResult {
  /** Whether context fetch was successful */
  success: boolean;

  /** Context items from Cerebro (bounded and redacted) */
  items: Array<{
    id: string;
    source_type: string;
    source_id: string;
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }>;

  /** Query used to fetch context */
  query: string;

  /** Total available items (may exceed returned items due to bounds) */
  total_available: number;

  /** Whether results were truncated due to bounds */
  truncated: boolean;

  /** Whether the result is degraded (Cerebro unavailable, timeout, etc.) */
  degraded?: boolean;

  /** Reason for degradation if applicable */
  degraded_reason?: "unconfigured" | "unavailable" | "timeout" | "error" | "disabled";

  /** Audit metadata for the context fetch */
  audit: {
    fetched_at: string;
    bridge_config: ReturnType<typeof buildForgeBridgeAuditMetadata>;
    item_count: number;
    total_available: number;
    truncated: boolean;
  };
}

/**
 * Dependencies for the Forge context service (for testing/DI).
 */
export interface ForgeContextServiceDeps {
  cerebroClient: CerebroContextClient;
  log: typeof logger;
  now: () => Date;
}

/**
 * Create the Forge context injection service.
 * @requirements REQ-007 - disabled/no-op by default
 */
export function createForgeContextService(
  config: Config,
  deps: Partial<ForgeContextServiceDeps> = {},
) {
  const forgeConfig = parseForgeBridgeConfig(config);
  const cerebroConfig = parseCerebroContextClientConfig(config);

  // Use provided deps or create defaults
  const cerebroClient = deps.cerebroClient ?? createCerebroContextClient(cerebroConfig);
  const log = deps.log ?? logger;
  const now = deps.now ?? (() => new Date());

  /**
   * Check if Forge context injection is enabled.
   * Requires both Forge bridge config and Cerebro context client to be enabled.
   */
  function isEnabled(): boolean {
    return isForgeBridgeEnabled(forgeConfig) && cerebroClient.isEnabled();
  }

  /**
   * Get service configuration (redacted for logging).
   */
  function getConfig(): {
    forgeBridge: Omit<ForgeBridgeConfig, "cerebroToken"> & { cerebroToken: typeof REDACTED_EVENT_VALUE | undefined };
    cerebroContext: ReturnType<CerebroContextClient["getConfig"]>;
    enabled: boolean;
  } {
    return {
      forgeBridge: {
        ...forgeConfig,
        cerebroToken: forgeConfig.cerebroToken ? REDACTED_EVENT_VALUE : undefined,
      },
      cerebroContext: cerebroClient.getConfig(),
      enabled: isEnabled(),
    };
  }

  /**
   * Fetch bounded context for a Forge scope.
   * @requirements REQ-003, REQ-005, REQ-008, REQ-010
   */
  async function fetchContext(input: FetchForgeContextInput): Promise<ForgeContextResult> {
    const fetchedAt = now().toISOString();

    // Check if service is enabled
    if (!isEnabled()) {
      log.debug({
        companyId: input.companyId,
        forgeChangeId: input.forgeChangeId,
        reason: forgeConfig.enabled ? "cerebro_unconfigured" : "bridge_disabled",
      }, "Forge context service disabled, returning degraded result");

      return {
        success: true, // Fail-open: not an error, just no context
        items: [],
        query: buildForgeQueryText(input),
        total_available: 0,
        truncated: false,
        degraded: true,
        degraded_reason: forgeConfig.enabled ? "unconfigured" : "disabled",
        audit: {
          fetched_at: fetchedAt,
          bridge_config: buildForgeBridgeAuditMetadata(forgeConfig),
          item_count: 0,
          total_available: 0,
          truncated: false,
        },
      };
    }

    try {
      // Build context query input for Cerebro
      const contextInput: BuildContextQueryInput = {
        companyId: input.companyId,
        projectId: input.projectId,
        issueId: input.issueId,
        runId: input.runId,
        agentId: input.agentId,
        mode: input.mode,
        role: input.role,
        tags: [
          ...(input.tags || []),
          `forge_change:${input.forgeChangeId}`,
          ...(input.forgeWorkerId ? [`forge_worker:${input.forgeWorkerId}`] : []),
          ...(input.forgeTaskId ? [`forge_task:${input.forgeTaskId}`] : []),
        ],
      };

      // Fetch context from Cerebro
      const result = await cerebroClient.fetchContext(contextInput);

      // Process result
      const isDegraded = "degraded" in result && result.degraded;

      log.debug({
        companyId: input.companyId,
        forgeChangeId: input.forgeChangeId,
        itemCount: result.items.length,
        totalAvailable: result.total_available,
        degraded: isDegraded,
      }, "Forge context fetched");

      return {
        success: true,
        items: result.items,
        query: result.query,
        total_available: result.total_available,
        truncated: result.truncated,
        degraded: isDegraded,
        degraded_reason: isDegraded ? result.reason : undefined,
        audit: {
          fetched_at: fetchedAt,
          bridge_config: buildForgeBridgeAuditMetadata(forgeConfig),
          item_count: result.items.length,
          total_available: result.total_available,
          truncated: result.truncated,
        },
      };
    } catch (error) {
      // Fail-open: log error but return degraded result, don't throw
      const errorMessage = error instanceof Error ? error.message : String(error);

      log.warn({
        companyId: input.companyId,
        forgeChangeId: input.forgeChangeId,
        error: errorMessage,
      }, "Forge context fetch failed (fail-open)");

      return {
        success: false,
        items: [],
        query: buildForgeQueryText(input),
        total_available: 0,
        truncated: false,
        degraded: true,
        degraded_reason: "error",
        audit: {
          fetched_at: fetchedAt,
          bridge_config: buildForgeBridgeAuditMetadata(forgeConfig),
          item_count: 0,
          total_available: 0,
          truncated: false,
        },
      };
    }
  }

  /**
   * Build query text for Forge context (used when Cerebro is unavailable).
   */
  function buildForgeQueryText(input: FetchForgeContextInput): string {
    return buildRoleAwareQueryText({
      companyId: input.companyId,
      projectId: input.projectId,
      issueId: input.issueId,
      runId: input.runId,
      agentId: input.agentId,
      mode: input.mode,
      role: input.role,
      tags: [
        ...(input.tags || []),
        `forge_change:${input.forgeChangeId}`,
      ],
    });
  }

  return {
    isEnabled,
    getConfig,
    fetchContext,
  };
}

/**
 * Type for the Forge context service.
 */
export type ForgeContextService = ReturnType<typeof createForgeContextService>;
