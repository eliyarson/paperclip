import { randomUUID, createHash } from "node:crypto";
import type { Config } from "../config.js";
import { logger } from "../middleware/logger.js";
import { redactEventPayload, REDACTED_EVENT_VALUE } from "../redaction.js";

/**
 * Cerebro lifecycle hook emitter configuration.
 * Parsed from environment variables or config object.
 */
export interface CerebroLifecycleHooksConfig {
  /** Whether hook emission is enabled. Default: false when no URL configured. */
  enabled: boolean;
  /** Cerebro daemon hooks endpoint URL. */
  hookUrl: string | undefined;
  /** Bearer token for authentication. */
  bearerToken: string | undefined;
  /** Tenant/company identifier. */
  tenant: string | undefined;
  /** Workspace identifier (optional). */
  workspace: string | undefined;
  /** Member identifier (optional). */
  member: string | undefined;
  /** HTTP timeout in milliseconds. Default: 5000ms. */
  timeoutMs: number;
}

/**
 * Paperclip lifecycle event envelope for Cerebro ingestion.
 * Matches the Cerebro runtime adapter expectations.
 */
export interface CerebroLifecycleEvent {
  host: "paperclip";
  event_type: string;
  source_id: string;
  tenant: string | undefined;
  timestamp: string;
  actor: {
    kind: "agent" | "system" | "operator";
    id: string;
  };
  entities: {
    run_id?: string;
    issue_id?: string;
    agent_id?: string;
    adapter_type?: string;
    project_id?: string;
    workspace_id?: string;
    forge_change_id?: string;
    [key: string]: string | undefined;
  };
  payload: Record<string, unknown> | null;
}

/**
 * Input for building a lifecycle event.
 */
export interface BuildLifecycleEventInput {
  eventType: string;
  tenant: string | undefined;
  actor: {
    kind: "agent" | "system" | "operator";
    id: string;
  };
  entities: {
    run_id?: string;
    issue_id?: string;
    agent_id?: string;
    adapter_type?: string;
    project_id?: string;
    workspace_id?: string;
    forge_change_id?: string;
    [key: string]: string | undefined;
  };
  payload?: Record<string, unknown> | null;
  sourceKey?: string;
  sequence?: number;
  timestamp?: Date;
}

/**
 * Result of a hook delivery attempt.
 */
export interface HookDeliveryResult {
  success: boolean;
  sourceId: string;
  error?: string;
  redacted: boolean;
}

/**
 * Dependencies for the lifecycle hook emitter (for testing/DI).
 */
export interface LifecycleHookEmitterDeps {
  fetch: typeof fetch;
  now: () => Date;
  log: typeof logger;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_PAYLOAD_SIZE_BYTES = 256 * 1024; // 256KB

/**
 * Parse Cerebro lifecycle hooks configuration from environment and config.
 */
export function parseCerebroLifecycleHooksConfig(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): CerebroLifecycleHooksConfig {
  const hookUrl = env.PAPERCLIP_CEREBRO_HOOK_URL?.trim() || undefined;
  const bearerToken = env.PAPERCLIP_CEREBRO_HOOK_TOKEN?.trim() || undefined;
  const enabledFromEnv = env.PAPERCLIP_CEREBRO_HOOK_ENABLED?.trim();
  
  // Default: enabled only if URL is configured
  const enabled = enabledFromEnv !== undefined
    ? enabledFromEnv === "true"
    : !!hookUrl;

  const timeoutMs = Math.max(
    1000,
    Math.min(
      30000,
      Number(env.PAPERCLIP_CEREBRO_HOOK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    ),
  );

  return {
    enabled,
    hookUrl,
    bearerToken,
    tenant: undefined, // Set per-event from context
    workspace: undefined,
    member: undefined,
    timeoutMs,
  };
}

/**
 * Generate a deterministic source ID for idempotent hook delivery.
 * Format: paperclip:<tenant>:<entity_type>:<entity_id>:<event_type>:<sequence_or_timestamp>
 * 
 * Uses stable components (tenant, event type, entity, sequence) for the hash
 * to ensure deterministic source_id even when timestamp varies.
 */
export function generateDeterministicSourceId(
  tenant: string | undefined,
  eventType: string,
  entities: BuildLifecycleEventInput["entities"],
  sequence: number,
  _timestamp: Date,
  sourceKey?: string,
): string {
  const tenantPart = tenant || "unknown";
  const primaryEntity = entities.run_id || entities.issue_id || entities.agent_id || "system";
  const sequencePart = sequence;
  
  // Stable hash using tenant/event/entity/sequence (deterministic regardless of timestamp)
  // This ensures the same logical event produces the same source_id even if
  // the caller doesn't provide a stable timestamp
  const stableHashInput = `${tenantPart}:${eventType}:${primaryEntity}:${sequencePart}:${sourceKey ?? ""}`;
  const hash = createHash("sha256").update(stableHashInput).digest("hex").slice(0, 16);
  
  return `paperclip:${tenantPart}:${eventType}:${primaryEntity}:${hash}`;
}

/**
 * Build a Cerebro lifecycle event envelope.
 */
export function buildLifecycleEvent(
  input: BuildLifecycleEventInput,
): CerebroLifecycleEvent {
  const timestamp = input.timestamp ?? new Date();
  const sequence = input.sequence ?? 0;
  const sourceId = generateDeterministicSourceId(
    input.tenant,
    input.eventType,
    input.entities,
    sequence,
    timestamp,
    input.sourceKey,
  );

  // Redact sensitive fields from payload
  const redactedPayload = input.payload
    ? redactEventPayload(input.payload)
    : null;

  return {
    host: "paperclip",
    event_type: input.eventType,
    source_id: sourceId,
    tenant: input.tenant,
    timestamp: timestamp.toISOString(),
    actor: input.actor,
    entities: input.entities,
    payload: redactedPayload,
  };
}

/**
 * Serialize event with payload bounds checking.
 */
function serializeEventWithBounds(event: CerebroLifecycleEvent): {
  body: string;
  truncated: boolean;
} {
  const body = JSON.stringify(event);
  
  if (body.length <= MAX_PAYLOAD_SIZE_BYTES) {
    return { body, truncated: false };
  }

  // Truncate payload if too large
  const truncatedEvent: CerebroLifecycleEvent = {
    ...event,
    payload: {
      _truncated: true,
      _originalSizeBytes: body.length,
      _reason: "payload_exceeds_max_size",
    },
  };

  return {
    body: JSON.stringify(truncatedEvent),
    truncated: true,
  };
}

/**
 * Deliver a lifecycle hook to Cerebro.
 * Fail-open: errors are logged but not thrown.
 */
export async function deliverLifecycleHook(
  config: CerebroLifecycleHooksConfig,
  event: CerebroLifecycleEvent,
  deps: LifecycleHookEmitterDeps,
): Promise<HookDeliveryResult> {
  if (!config.enabled || !config.hookUrl) {
    return {
      success: true,
      sourceId: event.source_id,
      redacted: true,
    };
  }

  const { body, truncated } = serializeEventWithBounds(event);
  const sourceId = event.source_id;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (config.bearerToken) {
      headers["Authorization"] = `Bearer ${config.bearerToken}`;
    }

    const response = await deps.fetch(config.hookUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorMsg = `Hook delivery failed: ${response.status} ${response.statusText}`;
      deps.log.warn({ 
        sourceId, 
        status: response.status,
        eventType: event.event_type,
      }, "Cerebro lifecycle hook delivery failed (non-2xx)");
      return {
        success: false,
        sourceId,
        error: errorMsg,
        redacted: true,
      };
    }

    deps.log.debug({ 
      sourceId, 
      eventType: event.event_type,
      truncated,
    }, "Cerebro lifecycle hook delivered");

    return {
      success: true,
      sourceId,
      redacted: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && 
      (error.name === "AbortError" || errorMessage.includes("timeout"));

    deps.log.warn({
      sourceId,
      eventType: event.event_type,
      isTimeout,
      error: isTimeout ? "timeout" : "network_error",
    }, "Cerebro lifecycle hook delivery failed (fail-open)");

    return {
      success: false,
      sourceId,
      error: isTimeout ? "Delivery timeout" : `Network error: ${errorMessage}`,
      redacted: true,
    };
  }
}

/**
 * Create a lifecycle hook emitter service.
 * This is the main interface for emitting lifecycle events.
 */
export interface CerebroLifecycleHookEmitter {
  /**
   * Emit a lifecycle event to Cerebro.
   * Fail-open: never throws, returns result with success status.
   */
  emit(input: BuildLifecycleEventInput): Promise<HookDeliveryResult>;
  
  /**
   * Check if hook emission is enabled.
   */
  isEnabled(): boolean;
}

/**
 * Create a no-op lifecycle hook emitter (when disabled).
 */
function createNoopEmitter(): CerebroLifecycleHookEmitter {
  return {
    async emit(input: BuildLifecycleEventInput): Promise<HookDeliveryResult> {
      return {
        success: true,
        sourceId: generateDeterministicSourceId(
          input.tenant,
          input.eventType,
          input.entities,
          input.sequence ?? 0,
          input.timestamp ?? new Date(),
          input.sourceKey,
        ),
        redacted: true,
      };
    },
    isEnabled: () => false,
  };
}

/**
 * Create a real lifecycle hook emitter.
 */
function createRealEmitter(
  config: CerebroLifecycleHooksConfig,
  deps: LifecycleHookEmitterDeps,
): CerebroLifecycleHookEmitter {
  return {
    async emit(input: BuildLifecycleEventInput): Promise<HookDeliveryResult> {
      const event = buildLifecycleEvent(input);
      return deliverLifecycleHook(config, event, deps);
    },
    isEnabled: () => true,
  };
}

/**
 * Create the lifecycle hook emitter service.
 * Returns a no-op emitter if not configured or disabled.
 */
export function createCerebroLifecycleHookEmitter(
  config: CerebroLifecycleHooksConfig,
  deps: LifecycleHookEmitterDeps = {
    fetch: globalThis.fetch,
    now: () => new Date(),
    log: logger,
  },
): CerebroLifecycleHookEmitter {
  if (!config.enabled || !config.hookUrl) {
    return createNoopEmitter();
  }
  return createRealEmitter(config, deps);
}

// Convenience event type constants
export const CEREBRO_LIFECYCLE_EVENT_TYPES = {
  RUN_STARTED: "paperclip.run.started",
  RUN_ADAPTER_INVOKED: "paperclip.run.adapter_invoked",
  RUN_SUCCEEDED: "paperclip.run.succeeded",
  RUN_FAILED: "paperclip.run.failed",
  RUN_CANCELLED: "paperclip.run.cancelled",
  ISSUE_STATUS_CHANGED: "paperclip.issue.status_changed",
  ISSUE_COMPLETED_BLOCKED: "paperclip.issue.completed_blocked",
  FORGE_LINKED: "paperclip.forge.linked",
  FORGE_STATUS_CHANGED: "paperclip.forge.status_changed",
  FORGE_DELEGATION_STARTED: "paperclip.forge.delegation_started",
  FORGE_COMPLETION_BLOCKED: "paperclip.forge.completion_blocked",
} as const;

/**
 * Helper to emit issue status changed lifecycle hook.
 * Fail-open: errors are logged but never thrown.
 */
export async function emitIssueStatusChanged(
  emitter: CerebroLifecycleHookEmitter | null | undefined,
  input: {
    companyId: string;
    issueId: string;
    previousStatus: string;
    newStatus: string;
    actorAgentId?: string | null;
    actorUserId?: string | null;
    assigneeAgentId?: string | null;
    originKind?: string | null;
    originId?: string | null;
  },
): Promise<void> {
  if (!emitter || !emitter.isEnabled()) return;

  const actor = input.actorUserId
    ? { kind: "operator" as const, id: input.actorUserId }
    : input.actorAgentId
      ? { kind: "agent" as const, id: input.actorAgentId }
      : { kind: "system" as const, id: "system" };

  try {
    await emitter.emit({
      eventType: CEREBRO_LIFECYCLE_EVENT_TYPES.ISSUE_STATUS_CHANGED,
      tenant: input.companyId,
      actor,
      entities: {
        issue_id: input.issueId,
        agent_id: input.assigneeAgentId ?? undefined,
        origin_kind: input.originKind ?? undefined,
        origin_id: input.originId ?? undefined,
      },
      payload: {
        previous_status: input.previousStatus,
        new_status: input.newStatus,
        transition: `${input.previousStatus}_to_${input.newStatus}`,
      },
      sourceKey: `transition:${input.previousStatus}->${input.newStatus}`,
    });
  } catch (err) {
    // Fail-open: log but never throw
    logger.warn(
      { err, issueId: input.issueId, eventType: CEREBRO_LIFECYCLE_EVENT_TYPES.ISSUE_STATUS_CHANGED },
      "Failed to emit issue status changed lifecycle hook (fail-open)",
    );
  }
}

/**
 * Helper to emit issue completion blocked lifecycle hook.
 * Fail-open: errors are logged but never thrown.
 */
export async function emitIssueCompletedBlocked(
  emitter: CerebroLifecycleHookEmitter | null | undefined,
  input: {
    companyId: string;
    issueId: string;
    reason: string;
    code: string;
    originKind?: string | null;
    originId?: string | null;
    forgeStatus?: string | null;
    actorAgentId?: string | null;
    actorUserId?: string | null;
  },
): Promise<void> {
  if (!emitter || !emitter.isEnabled()) return;

  const actor = input.actorUserId
    ? { kind: "operator" as const, id: input.actorUserId }
    : input.actorAgentId
      ? { kind: "agent" as const, id: input.actorAgentId }
      : { kind: "system" as const, id: "system" };

  try {
    // Build payload with redacted reason/context
    const payload: Record<string, unknown> = {
      blocked: true,
      reason_code: input.code,
      // Redact detailed reason to avoid leaking sensitive context
      reason_summary: input.reason.slice(0, 100),
    };

    // Include Forge metadata if available (without sensitive details)
    if (input.originKind) {
      payload.origin_kind = input.originKind;
    }
    if (input.originId) {
      payload.origin_id = input.originId;
    }
    if (input.forgeStatus) {
      payload.forge_status = input.forgeStatus;
    }

    await emitter.emit({
      eventType: CEREBRO_LIFECYCLE_EVENT_TYPES.ISSUE_COMPLETED_BLOCKED,
      tenant: input.companyId,
      actor,
      entities: {
        issue_id: input.issueId,
        origin_kind: input.originKind ?? undefined,
        origin_id: input.originId ?? undefined,
      },
      payload,
      sourceKey: `blocked:${input.code}:${input.forgeStatus ?? ""}:${input.originId ?? ""}`,
    });
  } catch (err) {
    // Fail-open: log but never throw
    logger.warn(
      { err, issueId: input.issueId, eventType: CEREBRO_LIFECYCLE_EVENT_TYPES.ISSUE_COMPLETED_BLOCKED },
      "Failed to emit issue completion blocked lifecycle hook (fail-open)",
    );
  }
}

/**
 * Helper to emit Forge-linked lifecycle hooks when Forge metadata is available.
 * Fail-open: errors are logged but never thrown.
 */
export async function emitForgeLifecycleEvent(
  emitter: CerebroLifecycleHookEmitter | null | undefined,
  input: {
    eventType: typeof CEREBRO_LIFECYCLE_EVENT_TYPES.FORGE_LINKED | typeof CEREBRO_LIFECYCLE_EVENT_TYPES.FORGE_STATUS_CHANGED | typeof CEREBRO_LIFECYCLE_EVENT_TYPES.FORGE_DELEGATION_STARTED | typeof CEREBRO_LIFECYCLE_EVENT_TYPES.FORGE_COMPLETION_BLOCKED;
    companyId: string;
    issueId: string;
    forgeChangeId: string;
    forgeStatus?: string | null;
    previousForgeStatus?: string | null;
    actorAgentId?: string | null;
    actorUserId?: string | null;
  },
): Promise<void> {
  if (!emitter || !emitter.isEnabled()) return;

  const actor = input.actorUserId
    ? { kind: "operator" as const, id: input.actorUserId }
    : input.actorAgentId
      ? { kind: "agent" as const, id: input.actorAgentId }
      : { kind: "system" as const, id: "system" };

  try {
    const payload: Record<string, unknown> = {
      forge_change_id: input.forgeChangeId,
    };

    if (input.forgeStatus) {
      payload.forge_status = input.forgeStatus;
    }
    if (input.previousForgeStatus) {
      payload.previous_forge_status = input.previousForgeStatus;
    }

    await emitter.emit({
      eventType: input.eventType,
      tenant: input.companyId,
      actor,
      entities: {
        issue_id: input.issueId,
        forge_change_id: input.forgeChangeId,
      },
      payload,
      sourceKey: `forge:${input.forgeChangeId}:${input.previousForgeStatus ?? ""}->${input.forgeStatus ?? ""}`,
    });
  } catch (err) {
    // Fail-open: log but never throw
    logger.warn(
      { err, issueId: input.issueId, eventType: input.eventType },
      "Failed to emit Forge lifecycle hook (fail-open)",
    );
  }
}
