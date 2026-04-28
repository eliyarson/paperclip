import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { parseObject, asString } from "../utils.js";
import { redactSensitiveValues, redactSensitiveObject, buildForgeEndpoint } from "./utils.js";
import type { ForgeAdapterConfig } from "./test.js";

// Forge API response types
interface ForgeChangeResponse {
  change_id?: string;
  status?: string;
  title?: string;
  owner?: string;
  created_at?: string;
  updated_at?: string;
}

interface ForgeWorkerRegistration {
  worker_id: string;
  registered_at: string;
}

interface ForgeTaskClaim {
  task_id: string;
  change_id: string;
  status: string;
  claimed_at: string;
  lease_expires_at?: string;
}

interface ForgeEvidenceResponse {
  evidence_id: string;
  attached_at: string;
}

/**
 * Extract change_id from execution context.
 * Priority:
 * 1. Linked issue context (originKind="forge_charter", originId=<change_id>)
 * 2. Config changeId fallback
 */
function resolveChangeId(
  context: Record<string, unknown>,
  config: ForgeAdapterConfig,
): { changeId: string | null; source: "linked_issue" | "config_fallback" | null } {
  // Check for linked issue context
  const issue = context.issue as Record<string, unknown> | undefined;
  if (issue) {
    const originKind = asString(issue.originKind, "");
    const originId = asString(issue.originId, "");
    if (originKind === "forge_charter" && originId) {
      return { changeId: originId, source: "linked_issue" };
    }
  }

  // Fallback to config
  const configChangeId = asString(config.changeId, "");
  if (configChangeId) {
    return { changeId: configChangeId, source: "config_fallback" };
  }

  return { changeId: null, source: null };
}

/**
 * Determine if an error is retryable based on HTTP status or error type.
 */
function isRetryableError(status: number | null, errorMessage: string): boolean {
  // Network errors are retryable
  if (status === null) return true;
  // 5xx server errors are retryable
  if (status >= 500 && status < 600) return true;
  // 429 rate limit is retryable
  if (status === 429) return true;
  // 408 timeout is retryable
  if (status === 408) return true;
  // 502, 503, 504 gateway errors are retryable
  if ([502, 503, 504].includes(status)) return true;
  return false;
}

/**
 * Build safe result metadata with token redaction.
 */
function buildSafeResult(
  changeId: string,
  forgeStatus: string,
  workerId?: string,
  taskId?: string,
  evidenceId?: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    changeId,
    forgeStatus,
    adapter: "forge",
    executedAt: new Date().toISOString(),
  };

  if (workerId) {
    result.workerId = workerId;
  }
  if (taskId) {
    result.taskId = taskId;
  }
  if (evidenceId) {
    result.evidenceId = evidenceId;
  }

  return result;
}

/**
 * Execute the Forge adapter.
 * Calls Forge HTTP endpoints only - no DB or filesystem access.
 */
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, context, runId, agent } = ctx;
  const parsedConfig = parseObject(config) as ForgeAdapterConfig;

  // Validate required config
  const forgeApiUrl = asString(parsedConfig.forgeApiUrl, "");
  const forgeApiToken = asString(parsedConfig.forgeApiToken, "");

  if (!forgeApiUrl) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Missing required config: forgeApiUrl",
      errorCode: "forge_config_missing_url",
    };
  }

  if (!forgeApiToken) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Missing required config: forgeApiToken",
      errorCode: "forge_config_missing_token",
    };
  }

  // Resolve change_id from context or config
  const { changeId, source } = resolveChangeId(context, parsedConfig);
  if (!changeId) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Could not resolve change_id from linked issue context or config.changeId",
      errorCode: "forge_change_id_unresolved",
    };
  }

  // Build common headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${forgeApiToken}`,
  };

  try {
    // Step 1: Get change status from Forge
    const changeEndpoint = buildForgeEndpoint(forgeApiUrl, `/api/spec/changes/${encodeURIComponent(changeId)}`);
    const changeResponse = await fetch(changeEndpoint, {
      method: "GET",
      headers,
    });

    if (!changeResponse.ok) {
      const isRetryable = isRetryableError(changeResponse.status, "");
      const redactedMessage = redactSensitiveValues(
        `Forge API returned HTTP ${changeResponse.status} for change ${changeId}`
      );
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: redactedMessage,
        errorCode: isRetryable ? "forge_api_retryable" : "forge_api_error",
        errorFamily: isRetryable ? "transient_upstream" : null,
        retryNotBefore: isRetryable ? new Date(Date.now() + 30000).toISOString() : null,
        resultJson: { changeId, requestedStatus: changeResponse.status },
      };
    }

    const changeData = (await changeResponse.json()) as ForgeChangeResponse;
    const forgeStatus = changeData.status || "unknown";

    // Step 2: Register a worker for this execution
    const workerEndpoint = buildForgeEndpoint(forgeApiUrl, "/api/spec/workers/register");
    const workerPayload = {
      change_id: changeId,
      run_id: runId,
      agent_id: agent.id,
      company_id: agent.companyId,
      organization_id: parsedConfig.organizationId,
      workspace_id: parsedConfig.workspaceId,
      project_id: parsedConfig.projectId,
      worker_id: parsedConfig.workerId,
      registered_at: new Date().toISOString(),
    };

    const workerResponse = await fetch(workerEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(workerPayload),
    });

    let workerId: string | undefined;
    if (workerResponse.ok) {
      const workerData = (await workerResponse.json()) as ForgeWorkerRegistration;
      workerId = workerData.worker_id;
    }
    // Non-ok worker registration is not fatal - continue with execution

    // Step 3: Claim or inspect a task for this change
    const taskEndpoint = buildForgeEndpoint(forgeApiUrl, "/api/spec/tasks/claim");
    const taskPayload = {
      change_id: changeId,
      worker_id: workerId,
      run_id: runId,
      claimed_at: new Date().toISOString(),
    };

    const taskResponse = await fetch(taskEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(taskPayload),
    });

    let taskId: string | undefined;
    let leaseExpiresAt: string | undefined;
    if (taskResponse.ok) {
      const taskData = (await taskResponse.json()) as ForgeTaskClaim;
      taskId = taskData.task_id;
      leaseExpiresAt = taskData.lease_expires_at;
    }
    // Non-ok task claim is not fatal - continue with execution

    // Step 4: Heartbeat the task lease if we have a task
    if (taskId && workerId) {
      const heartbeatEndpoint = buildForgeEndpoint(forgeApiUrl, "/api/spec/tasks/heartbeat");
      const heartbeatPayload = {
        change_id: changeId,
        task_id: taskId,
        worker_id: workerId,
        run_id: runId,
        agent_id: agent.id,
        heartbeat_at: new Date().toISOString(),
      };

      try {
        const heartbeatResponse = await fetch(heartbeatEndpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(heartbeatPayload),
        });

        if (!heartbeatResponse.ok) {
          // Heartbeat failure means lease may not be valid - fail closed
          const isRetryable = isRetryableError(heartbeatResponse.status, "");
          const redactedMessage = redactSensitiveValues(
            `Forge task heartbeat failed with HTTP ${heartbeatResponse.status}`
          );
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: redactedMessage,
            errorCode: isRetryable ? "forge_heartbeat_retryable" : "forge_heartbeat_failed",
            errorFamily: isRetryable ? "transient_upstream" : null,
            retryNotBefore: isRetryable ? new Date(Date.now() + 30000).toISOString() : null,
            resultJson: { changeId, taskId, workerId, heartbeatStatus: heartbeatResponse.status },
          };
        }
      } catch (err) {
        // Network error during heartbeat - fail closed with retryable error
        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        const redactedMessage = redactSensitiveValues(errorMessage);
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `Forge task heartbeat failed: ${redactedMessage}`,
          errorCode: "forge_heartbeat_retryable",
          errorFamily: "transient_upstream",
          retryNotBefore: new Date(Date.now() + 30000).toISOString(),
          resultJson: { changeId, taskId, workerId, error: redactedMessage },
        };
      }
    }

    // Step 5: Attach start evidence
    const evidenceEndpoint = buildForgeEndpoint(forgeApiUrl, "/api/spec/evidence");
    const evidencePayload = {
      change_id: changeId,
      task_id: taskId,
      worker_id: workerId,
      run_id: runId,
      agent_id: agent.id,
      evidence_type: "execution_start",
      metadata: redactSensitiveObject({
        source,
        forgeStatus,
        organizationId: parsedConfig.organizationId,
        workspaceId: parsedConfig.workspaceId,
        projectId: parsedConfig.projectId,
      }),
      attached_at: new Date().toISOString(),
    };

    const evidenceResponse = await fetch(evidenceEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(evidencePayload),
    });

    let evidenceId: string | undefined;
    if (evidenceResponse.ok) {
      const evidenceData = (await evidenceResponse.json()) as ForgeEvidenceResponse;
      evidenceId = evidenceData.evidence_id;
    }
    // Non-ok evidence attachment is not fatal

    // Build safe result with redacted metadata
    const safeResult = buildSafeResult(changeId, forgeStatus, workerId, taskId, evidenceId);
    const redactedResult = redactSensitiveObject(safeResult);

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `Forge adapter executed for change ${changeId} (status: ${forgeStatus})`,
      resultJson: redactedResult,
      provider: "forge",
      model: "forge-charter",
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    const redactedMessage = redactSensitiveValues(errorMessage);
    const isRetryable = isRetryableError(null, errorMessage);

    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: redactedMessage,
      errorCode: isRetryable ? "forge_execution_retryable" : "forge_execution_failed",
      errorFamily: isRetryable ? "transient_upstream" : null,
      retryNotBefore: isRetryable ? new Date(Date.now() + 30000).toISOString() : null,
      resultJson: { changeId, error: redactedMessage },
    };
  }
}
