/**
 * Forge Bridge Integration Service
 *
 * Integrates Forge adapter/run bridge capture at bounded checkpoints.
 * Fail-open: disabled config, timeouts, network errors, and Cerebro errors
 * never block Forge adapter/run execution.
 *
 * Degraded metadata is visible in run/audit metadata without secret leakage
 * and without claiming observation persistence.
 *
 * @checkpoint paperclip-forge-cerebro-memory-bridge-v0
 * @requirements REQ-001, REQ-005, REQ-006, REQ-007, REQ-008, REQ-009, REQ-010
 */

import type { Config } from "../config.js";
import { logger } from "../middleware/logger.js";
import {
  createForgeWritebackService,
  type WriteForgeObservationsInput,
} from "./forge-observation-writeback.js";
import {
  mapForgeEventsToObservations,
  type ForgeEvent,
  type ForgeEventScope,
} from "./forge-observation-mapper.js";
import { parseForgeBridgeConfig } from "./forge-bridge-config.js";

/**
 * Input for capturing a Forge adapter checkpoint.
 */
export interface CaptureForgeCheckpointInput {
  /** Company/tenant identifier */
  companyId: string;

  /** Project identifier (optional) */
  projectId?: string;

  /** Agent identifier */
  agentId: string;

  /** Run identifier */
  runId: string;

  /** Issue identifier (optional) */
  issueId?: string;

  /** Forge change_id */
  forgeChangeId: string;

  /** Forge worker_id (optional) */
  forgeWorkerId?: string;

  /** Forge task_id (optional) */
  forgeTaskId?: string;

  /** Forge evidence_id (optional) */
  forgeEvidenceId?: string;

  /** Checkpoint type */
  checkpoint: "execution_start" | "execution_complete" | "execution_failed" | "heartbeat" | "evidence_attached";

  /** Forge status at checkpoint */
  forgeStatus?: string;

  /** Adapter outcome */
  outcome?: "success" | "failed" | "retryable" | "timeout" | "cancelled";

  /** Exit code if available */
  exitCode?: number;

  /** Error code if failed */
  errorCode?: string;

  /** Error message if failed (will be redacted) */
  errorMessage?: string;

  /** Summary of execution */
  summary?: string;

  /** Additional metadata (will be redacted) */
  metadata?: Record<string, unknown>;

  /** Actor information */
  actor: {
    kind: "agent" | "system" | "operator";
    id: string;
  };
}

/**
 * Result of capturing a Forge checkpoint.
 */
export interface CaptureForgeCheckpointResult {
  /** Whether the capture was successful */
  success: boolean;

  /** Whether the result is degraded */
  degraded: boolean;

  /** Reason for degradation if applicable */
  degradedReason?: string;

  /** Number of observations accepted */
  acceptedCount: number;

  /** Error code if failed */
  errorCode?: string;

  /** Error summary if failed (redacted) */
  errorSummary?: string;

  /** Bridge metadata for audit */
  bridgeMetadata: {
    enabled: boolean;
    configured: boolean;
    captured_at: string;
  };
}

/**
 * Dependencies for the Forge bridge integration service.
 */
export interface ForgeBridgeIntegrationDeps {
  writebackService: ReturnType<typeof createForgeWritebackService>;
  log: typeof logger;
  now: () => Date;
}

/**
 * Create the Forge bridge integration service.
 * @requirements REQ-007 - disabled/no-op by default
 */
export function createForgeBridgeIntegrationService(
  config: Config,
  deps: Partial<ForgeBridgeIntegrationDeps> = {},
) {
  const forgeConfig = parseForgeBridgeConfig(config);

  // Use provided deps or create defaults
  const writebackService = deps.writebackService ?? createForgeWritebackService(config);
  const log = deps.log ?? logger;
  const now = deps.now ?? (() => new Date());

  /**
   * Check if bridge integration is enabled.
   */
  function isEnabled(): boolean {
    return writebackService.isEnabled();
  }

  /**
   * Capture a Forge adapter checkpoint.
   * Fail-open: never throws, returns degraded result on error.
   * @requirements REQ-006, REQ-008
   */
  async function captureCheckpoint(
    input: CaptureForgeCheckpointInput,
  ): Promise<CaptureForgeCheckpointResult> {
    const capturedAt = now().toISOString();

    // Build bridge metadata for audit (always returned, even if disabled)
    const bridgeMetadata = {
      enabled: isEnabled(),
      configured: !!forgeConfig.cerebroUrl,
      captured_at: capturedAt,
    };

    // If bridge is disabled, return degraded result without calling Cerebro
    if (!isEnabled()) {
      log.debug({
        companyId: input.companyId,
        runId: input.runId,
        checkpoint: input.checkpoint,
        reason: forgeConfig.enabled ? "url_unconfigured" : "bridge_disabled",
      }, "Forge bridge checkpoint capture skipped (disabled)");

      return {
        success: true, // Not an error, just disabled
        degraded: true,
        degradedReason: forgeConfig.enabled ? "unconfigured" : "disabled",
        acceptedCount: 0,
        bridgeMetadata,
      };
    }

    try {
      // Build Forge events from checkpoint input
      const events = buildForgeEventsFromCheckpoint(input);

      if (events.length === 0) {
        // No memory-worthy events to capture
        return {
          success: true,
          degraded: false,
          acceptedCount: 0,
          bridgeMetadata,
        };
      }

      // Build write input
      const writeInput: WriteForgeObservationsInput = {
        companyId: input.companyId,
        projectId: input.projectId,
        agentId: input.agentId,
        runId: input.runId,
        issueId: input.issueId,
        forgeChangeId: input.forgeChangeId,
        events,
        actor: input.actor,
      };

      // Write observations (fail-open: service handles its own errors)
      const result = await writebackService.writeObservations(writeInput, input.companyId);

      log.debug({
        companyId: input.companyId,
        runId: input.runId,
        checkpoint: input.checkpoint,
        acceptedCount: result.acceptedCount,
        degraded: result.degraded,
      }, "Forge bridge checkpoint captured");

      return {
        success: result.success,
        degraded: result.degraded ?? false,
        degradedReason: result.degradedReason,
        acceptedCount: result.acceptedCount,
        errorCode: result.errorCode,
        errorSummary: result.errorSummary,
        bridgeMetadata,
      };
    } catch (error) {
      // Fail-open: log error but return degraded result, don't throw
      const errorMessage = error instanceof Error ? error.message : String(error);

      log.warn({
        companyId: input.companyId,
        runId: input.runId,
        checkpoint: input.checkpoint,
        error: errorMessage,
      }, "Forge bridge checkpoint capture failed (fail-open)");

      return {
        success: false,
        degraded: true,
        degradedReason: "error",
        acceptedCount: 0,
        errorCode: "capture_failed",
        errorSummary: errorMessage.slice(0, 200),
        bridgeMetadata,
      };
    }
  }

  /**
   * Build Forge events from checkpoint input.
   */
  function buildForgeEventsFromCheckpoint(input: CaptureForgeCheckpointInput): ForgeEvent[] {
    const baseScope: ForgeEventScope = {
      companyId: input.companyId,
      projectId: input.projectId,
      agentId: input.agentId,
      runId: input.runId,
      issueId: input.issueId,
      forgeChangeId: input.forgeChangeId,
      forgeWorkerId: input.forgeWorkerId,
      forgeTaskId: input.forgeTaskId,
      forgeEvidenceId: input.forgeEvidenceId,
    };

    const events: ForgeEvent[] = [];
    const timestamp = now().toISOString();

    switch (input.checkpoint) {
      case "execution_start":
        events.push({
          type: "forge_adapter_executed",
          scope: baseScope,
          outcome: "success",
          exitCode: 0,
          summary: input.summary,
          timestamp,
          metadata: input.metadata,
        });
        break;

      case "execution_complete":
        events.push({
          type: "forge_adapter_executed",
          scope: baseScope,
          outcome: input.outcome ?? "success",
          exitCode: input.exitCode,
          summary: input.summary,
          timestamp,
          metadata: input.metadata,
        });
        break;

      case "execution_failed":
        events.push({
          type: "forge_adapter_failed",
          scope: baseScope,
          outcome: input.outcome ?? "failed",
          exitCode: input.exitCode ?? 1,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          summary: input.summary,
          timestamp,
          metadata: input.metadata,
        });
        break;

      case "evidence_attached":
        events.push({
          type: "forge_evidence_attached",
          scope: baseScope,
          evidenceType: "execution_evidence",
          timestamp,
          metadata: input.metadata,
        });
        break;

      case "heartbeat":
        // Heartbeat events are not memory-worthy (skipped by mapper)
        break;
    }

    return events;
  }

  return {
    isEnabled,
    captureCheckpoint,
  };
}

/**
 * Type for the Forge bridge integration service.
 */
export type ForgeBridgeIntegrationService = ReturnType<typeof createForgeBridgeIntegrationService>;
