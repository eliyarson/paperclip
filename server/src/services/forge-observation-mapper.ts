/**
 * Forge-to-Cerebro Observation Taxonomy Mapper
 *
 * Maps Forge adapter/run statuses, outcomes, evidence artifacts, delegation events,
 * and completion signals to existing Cerebro observation taxonomy and learning
 * candidate/source fields.
 *
 * Preserves company/project/agent/run/issue/Forge artifact scope identifiers
 * and timestamps. Bounds and redacts evidence snippets.
 *
 * Skips/degrades unsupported/non-memory-worthy events deterministically.
 *
 * @checkpoint paperclip-forge-cerebro-memory-bridge-v0
 * @requirements REQ-001, REQ-002, REQ-005, REQ-006, REQ-009, REQ-012
 */

import type { CerebroObservationPayload } from "./cerebro-context-client.js";

// =============================================================================
// Secret Redaction for Metadata
// =============================================================================

/**
 * Redact secrets from metadata values.
 * @requirements REQ-010
 */
function redactSecretsFromValue(value: unknown): unknown {
  if (typeof value === "string") {
    // Redact bearer tokens
    let result = value.replace(/bearer\s+[a-zA-Z0-9_\-\.]+/gi, "bearer ***REDACTED***");
    // Redact token= or token: patterns
    result = result.replace(/(token\s*[:=]\s*)[a-zA-Z0-9_\-\.]+/gi, "$1***REDACTED***");
    // Redact api_key= or api_key: patterns
    result = result.replace(/(api[_-]?key\s*[:=]\s*)[a-zA-Z0-9_\-\.]+/gi, "$1***REDACTED***");
    // Redact secret= or secret: patterns
    result = result.replace(/(secret\s*[:=]\s*)\S+/gi, "$1***REDACTED***");
    // Redact OpenAI-style keys
    result = result.replace(/sk-[a-zA-Z0-9]{20,}/gi, "***REDACTED***");
    return result;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return redactSecretsFromMetadata(value as Record<string, unknown>);
  }
  if (Array.isArray(value)) {
    return value.map(redactSecretsFromValue);
  }
  return value;
}

/**
 * Redact secrets from metadata object.
 * @requirements REQ-010
 */
function redactSecretsFromMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    // If the key itself looks like a secret key, redact the value entirely
    if (/token|api[_-]?key|secret|password|credential/i.test(key)) {
      if (typeof value === "string" && value.length > 0) {
        result[key] = "***REDACTED***";
        continue;
      }
    }
    result[key] = redactSecretsFromValue(value);
  }
  return result;
}

// =============================================================================
// Forge Event Taxonomy
// =============================================================================

/**
 * Supported Forge event types that can be mapped to Cerebro observations.
 * These align with the lifecycle events in cerebro-lifecycle-hooks.ts
 */
export const FORGE_EVENT_TYPES = [
  "forge_linked",
  "forge_status_changed",
  "forge_delegation_started",
  "forge_delegation_completed",
  "forge_completion_blocked",
  "forge_evidence_attached",
  "forge_worker_registered",
  "forge_task_claimed",
  "forge_heartbeat_sent",
  "forge_adapter_executed",
  "forge_adapter_failed",
] as const;

export type ForgeEventType = typeof FORGE_EVENT_TYPES[number];

/**
 * Forge status values from the Forge API.
 */
export const FORGE_STATUSES = [
  "draft",
  "approved",
  "in_progress",
  "verified",
  "archived",
  "blocked",
  "failed",
] as const;

export type ForgeStatus = typeof FORGE_STATUSES[number];

/**
 * Forge adapter outcome types.
 */
export const FORGE_ADAPTER_OUTCOMES = [
  "success",
  "failed",
  "retryable",
  "timeout",
  "cancelled",
] as const;

export type ForgeAdapterOutcome = typeof FORGE_ADAPTER_OUTCOMES[number];

// =============================================================================
// Forge Event Payloads
// =============================================================================

/**
 * Base scope identifiers preserved across all Forge events.
 * @requirements REQ-005
 */
export interface ForgeEventScope {
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

  /** Forge evidence_id (optional) */
  forgeEvidenceId?: string;
}

/**
 * Forge status change event payload.
 */
export interface ForgeStatusChangeEvent {
  type: "forge_status_changed";
  scope: ForgeEventScope;
  previousStatus: ForgeStatus | null;
  newStatus: ForgeStatus;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Forge delegation event payload.
 */
export interface ForgeDelegationEvent {
  type: "forge_delegation_started" | "forge_delegation_completed";
  scope: ForgeEventScope;
  taskDescription?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Forge completion blocked event payload.
 */
export interface ForgeCompletionBlockedEvent {
  type: "forge_completion_blocked";
  scope: ForgeEventScope;
  reason: string;
  reasonCode: string;
  forgeStatus?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Forge evidence attached event payload.
 */
export interface ForgeEvidenceEvent {
  type: "forge_evidence_attached";
  scope: ForgeEventScope;
  evidenceType: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Forge adapter execution event payload.
 */
export interface ForgeAdapterExecutionEvent {
  type: "forge_adapter_executed" | "forge_adapter_failed";
  scope: ForgeEventScope;
  outcome: ForgeAdapterOutcome;
  exitCode?: number;
  errorCode?: string;
  errorMessage?: string;
  summary?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Union type for all supported Forge events.
 */
export type ForgeEvent =
  | ForgeStatusChangeEvent
  | ForgeDelegationEvent
  | ForgeCompletionBlockedEvent
  | ForgeEvidenceEvent
  | ForgeAdapterExecutionEvent;

// =============================================================================
// Observation Mapping
// =============================================================================

/**
 * Mapping from Forge event types to Cerebro observation types.
 * @requirements REQ-002
 */
const FORGE_EVENT_TO_OBSERVATION_TYPE: Record<ForgeEventType, CerebroObservationPayload["type"] | null> = {
  forge_linked: "decision",
  forge_status_changed: "outcome",
  forge_delegation_started: "decision",
  forge_delegation_completed: "outcome",
  forge_completion_blocked: "blocker",
  forge_evidence_attached: "evidence_summary",
  forge_worker_registered: null, // Not memory-worthy
  forge_task_claimed: null, // Not memory-worthy
  forge_heartbeat_sent: null, // Not memory-worthy
  forge_adapter_executed: "outcome",
  forge_adapter_failed: "blocker",
};

/**
 * Check if a Forge event type is supported for observation mapping.
 * Returns null for non-memory-worthy events.
 */
export function getObservationTypeForForgeEvent(
  eventType: ForgeEventType,
): CerebroObservationPayload["type"] | null {
  return FORGE_EVENT_TO_OBSERVATION_TYPE[eventType] ?? null;
}

/**
 * Determine if a Forge event should be captured as a Cerebro observation.
 * @requirements REQ-001
 */
export function isForgeEventMemoryWorthy(event: ForgeEvent): boolean {
  const observationType = getObservationTypeForForgeEvent(event.type);
  return observationType !== null;
}

// =============================================================================
// Content Builders
// =============================================================================

/**
 * Build observation content from Forge status change.
 */
function buildStatusChangeContent(event: ForgeStatusChangeEvent): string {
  const parts: string[] = [
    `Forge status changed for change ${event.scope.forgeChangeId}`,
  ];

  if (event.previousStatus) {
    parts.push(`From: ${event.previousStatus}`);
  }
  parts.push(`To: ${event.newStatus}`);

  if (event.scope.issueId) {
    parts.push(`Issue: ${event.scope.issueId}`);
  }

  return parts.join("\n");
}

/**
 * Build observation content from Forge delegation event.
 */
function buildDelegationContent(event: ForgeDelegationEvent): string {
  const action = event.type === "forge_delegation_started" ? "started" : "completed";
  const parts: string[] = [
    `Forge delegation ${action} for change ${event.scope.forgeChangeId}`,
  ];

  if (event.taskDescription) {
    parts.push(`Task: ${event.taskDescription.slice(0, 200)}`);
  }

  if (event.scope.forgeTaskId) {
    parts.push(`Task ID: ${event.scope.forgeTaskId}`);
  }

  return parts.join("\n");
}

/**
 * Build observation content from Forge completion blocked event.
 */
function buildCompletionBlockedContent(event: ForgeCompletionBlockedEvent): string {
  const parts: string[] = [
    `Forge completion blocked for change ${event.scope.forgeChangeId}`,
    `Reason: ${event.reason.slice(0, 200)}`,
    `Code: ${event.reasonCode}`,
  ];

  if (event.forgeStatus) {
    parts.push(`Forge status: ${event.forgeStatus}`);
  }

  return parts.join("\n");
}

/**
 * Build observation content from Forge evidence event.
 */
function buildEvidenceContent(event: ForgeEvidenceEvent): string {
  const parts: string[] = [
    `Forge evidence attached for change ${event.scope.forgeChangeId}`,
    `Evidence type: ${event.evidenceType}`,
  ];

  if (event.scope.forgeEvidenceId) {
    parts.push(`Evidence ID: ${event.scope.forgeEvidenceId}`);
  }

  return parts.join("\n");
}

/**
 * Build observation content from Forge adapter execution event.
 */
function buildAdapterExecutionContent(event: ForgeAdapterExecutionEvent): string {
  const parts: string[] = [
    `Forge adapter ${event.type === "forge_adapter_executed" ? "executed" : "failed"} for change ${event.scope.forgeChangeId}`,
    `Outcome: ${event.outcome}`,
  ];

  if (event.exitCode !== undefined) {
    parts.push(`Exit code: ${event.exitCode}`);
  }

  if (event.errorCode) {
    parts.push(`Error code: ${event.errorCode}`);
  }

  if (event.errorMessage) {
    parts.push(`Error: ${event.errorMessage.slice(0, 200)}`);
  }

  if (event.summary) {
    parts.push(`Summary: ${event.summary.slice(0, 300)}`);
  }

  return parts.join("\n");
}

// =============================================================================
// Tag Builders
// =============================================================================

/**
 * Build observation tags from Forge event scope.
 * @requirements REQ-005, REQ-006
 */
function buildObservationTags(event: ForgeEvent): string[] {
  const tags: string[] = [
    `forge_event:${event.type}`,
    `forge_change:${event.scope.forgeChangeId}`,
    `source:forge_bridge`,
  ];

  if (event.scope.projectId) {
    tags.push(`project:${event.scope.projectId}`);
  }

  if (event.scope.agentId) {
    tags.push(`agent:${event.scope.agentId}`);
  }

  if (event.scope.runId) {
    tags.push(`run:${event.scope.runId}`);
  }

  if (event.scope.issueId) {
    tags.push(`issue:${event.scope.issueId}`);
  }

  if (event.scope.forgeWorkerId) {
    tags.push(`forge_worker:${event.scope.forgeWorkerId}`);
  }

  if (event.scope.forgeTaskId) {
    tags.push(`forge_task:${event.scope.forgeTaskId}`);
  }

  // Add event-specific tags
  if (event.type === "forge_status_changed") {
    if (event.previousStatus) {
      tags.push(`previous_status:${event.previousStatus}`);
    }
    tags.push(`new_status:${event.newStatus}`);
  }

  if (event.type === "forge_adapter_executed" || event.type === "forge_adapter_failed") {
    tags.push(`outcome:${event.outcome}`);
    if (event.errorCode) {
      tags.push(`error_code:${event.errorCode}`);
    }
  }

  return tags;
}

// =============================================================================
// Metadata Builders
// =============================================================================

/**
 * Build source/evidence link metadata for learning candidates.
 * @requirements REQ-006
 */
function buildSourceMetadata(event: ForgeEvent): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    // Source identifiers for traceability
    source_type: "forge_bridge",
    source_id: `${event.type}:${event.scope.forgeChangeId}:${event.timestamp}`,
    source_timestamp: event.timestamp,

    // Forge scope identifiers
    forge_change_id: event.scope.forgeChangeId,

    // Paperclip scope identifiers
    company_id: event.scope.companyId,
  };

  // Optional scope identifiers
  if (event.scope.projectId) {
    metadata.project_id = event.scope.projectId;
  }

  if (event.scope.agentId) {
    metadata.agent_id = event.scope.agentId;
  }

  if (event.scope.runId) {
    metadata.run_id = event.scope.runId;
    metadata.source_run_url = `/runs/${event.scope.runId}`;
  }

  if (event.scope.issueId) {
    metadata.issue_id = event.scope.issueId;
    metadata.source_issue_url = `/issues/${event.scope.issueId}`;
  }

  if (event.scope.forgeWorkerId) {
    metadata.forge_worker_id = event.scope.forgeWorkerId;
  }

  if (event.scope.forgeTaskId) {
    metadata.forge_task_id = event.scope.forgeTaskId;
  }

  if (event.scope.forgeEvidenceId) {
    metadata.forge_evidence_id = event.scope.forgeEvidenceId;
  }

  // Event-specific metadata
  if (event.type === "forge_status_changed") {
    metadata.previous_status = event.previousStatus;
    metadata.new_status = event.newStatus;
  }

  if (event.type === "forge_completion_blocked") {
    metadata.blocked_reason = event.reason.slice(0, 100);
    metadata.blocked_reason_code = event.reasonCode;
    if (event.forgeStatus) {
      metadata.forge_status = event.forgeStatus;
    }
  }

  if (event.type === "forge_evidence_attached") {
    metadata.evidence_type = event.evidenceType;
  }

  if (event.type === "forge_adapter_executed" || event.type === "forge_adapter_failed") {
    metadata.adapter_outcome = event.outcome;
    if (event.exitCode !== undefined) {
      metadata.exit_code = event.exitCode;
    }
    if (event.errorCode) {
      metadata.error_code = event.errorCode;
    }
  }

  // Include any additional metadata from the event (bounded, redacted)
  if (event.metadata) {
    const redactedMetadata = redactSecretsFromMetadata(event.metadata);
    metadata.event_metadata = JSON.stringify(redactedMetadata).slice(0, 1000);
  }

  return metadata;
}

// =============================================================================
// Main Mapping Function
// =============================================================================

/**
 * Map a Forge event to a Cerebro observation payload.
 * Returns null if the event is not memory-worthy or unsupported.
 *
 * @requirements REQ-001, REQ-002, REQ-006
 */
export function mapForgeEventToObservation(
  event: ForgeEvent,
): CerebroObservationPayload | null {
  // Check if event is memory-worthy
  const observationType = getObservationTypeForForgeEvent(event.type);
  if (!observationType) {
    return null;
  }

  // Build content based on event type
  let content: string;
  switch (event.type) {
    case "forge_status_changed":
      content = buildStatusChangeContent(event);
      break;
    case "forge_delegation_started":
    case "forge_delegation_completed":
      content = buildDelegationContent(event);
      break;
    case "forge_completion_blocked":
      content = buildCompletionBlockedContent(event);
      break;
    case "forge_evidence_attached":
      content = buildEvidenceContent(event);
      break;
    case "forge_adapter_executed":
    case "forge_adapter_failed":
      content = buildAdapterExecutionContent(event);
      break;
    default:
      // Unsupported event type
      return null;
  }

  // Build tags and metadata
  const tags = buildObservationTags(event);
  const metadata = buildSourceMetadata(event);

  return {
    type: observationType,
    content,
    tags,
    metadata,
  };
}

// =============================================================================
// Batch Mapping
// =============================================================================

/**
 * Map multiple Forge events to Cerebro observations.
 * Filters out non-memory-worthy events and maps supported ones.
 *
 * @requirements REQ-001, REQ-002
 */
export function mapForgeEventsToObservations(
  events: ForgeEvent[],
): CerebroObservationPayload[] {
  const observations: CerebroObservationPayload[] = [];

  for (const event of events) {
    const observation = mapForgeEventToObservation(event);
    if (observation) {
      observations.push(observation);
    }
  }

  return observations;
}

// =============================================================================
// Content Bounds
// =============================================================================

/**
 * Apply bounds to observation content.
 * Truncates content to max length and adds truncation indicator.
 *
 * @requirements REQ-006
 */
export function boundObservationContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  const truncationIndicator = "\n[...truncated]";
  const availableLength = maxLength - truncationIndicator.length;
  return content.slice(0, availableLength) + truncationIndicator;
}

/**
 * Apply bounds to all observations in a batch.
 */
export function boundObservationBatch(
  observations: CerebroObservationPayload[],
  maxCharsPerObservation: number,
): CerebroObservationPayload[] {
  return observations.map((obs) => ({
    ...obs,
    content: boundObservationContent(obs.content, maxCharsPerObservation),
  }));
}
