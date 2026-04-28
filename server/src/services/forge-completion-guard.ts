/**
 * Forge Completion Guard Service
 *
 * Enforces that Forge-linked Paperclip issues cannot be marked done
 * unless the linked Charter is verified or archived in Forge.
 *
 * v0 Link Contract:
 * - issues.originKind === "forge_charter" indicates a Forge-linked issue
 * - issues.originId stores the Forge change_id
 *
 * Fail-closed behavior:
 * - Missing originId -> block
 * - Missing FORGE_API_URL -> block
 * - Forge unreachable/non-2xx -> block
 * - Forge status not verified/archived -> block
 */

import { logger } from "../middleware/logger.js";
import { conflict, HttpError } from "../errors.js";

export const FORGE_LINKED_ORIGIN_KIND = "forge_charter";

export interface ForgeLinkedIssue {
  id: string;
  companyId: string;
  originKind: string | null;
  originId: string | null;
  status: string;
}

export interface ForgeChangeStatus {
  changeId: string;
  status: string;
}

export interface ForgeCompletionGuardConfig {
  forgeApiUrl: string | undefined;
  forgeApiToken: string | undefined;
}

export interface ForgeCompletionGuardResult {
  allowed: boolean;
  reason?: string;
  changeId?: string;
  forgeStatus?: string;
}

export class ForgeCompletionGuardError extends HttpError {
  constructor(
    message: string,
    public readonly code: string,
    public readonly changeId: string | null,
    details?: Record<string, unknown>
  ) {
    super(409, message, { code, changeId, ...details });
  }
}

function getConfig(): ForgeCompletionGuardConfig {
  return {
    forgeApiUrl: process.env.FORGE_API_URL,
    forgeApiToken: process.env.FORGE_API_TOKEN,
  };
}

/**
 * Check if an issue is Forge-linked according to v0 contract.
 */
export function isForgeLinkedIssue(issue: { originKind: string | null; originId: string | null }): boolean {
  return issue.originKind === FORGE_LINKED_ORIGIN_KIND;
}

/**
 * Fetch Forge change status via HTTP API.
 * Returns null on any error to support fail-closed behavior at call site.
 */
export async function fetchForgeChangeStatus(
  changeId: string,
  config: ForgeCompletionGuardConfig,
  fetchImpl: typeof fetch = fetch
): Promise<ForgeChangeStatus | null> {
  if (!config.forgeApiUrl) {
    logger.warn({ changeId }, "FORGE_API_URL not configured, cannot fetch Forge status");
    return null;
  }

  const url = `${config.forgeApiUrl}/api/spec/changes/${encodeURIComponent(changeId)}`;

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (config.forgeApiToken) {
      headers.Authorization = `Bearer ${config.forgeApiToken}`;
    }

    const response = await fetchImpl(url, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      logger.warn(
        { changeId, status: response.status, statusText: response.statusText },
        "Forge API returned non-2xx response"
      );
      return null;
    }

    const data = await response.json() as { status?: string };

    if (typeof data.status !== "string") {
      logger.warn({ changeId, responseData: data }, "Forge API response missing status field");
      return null;
    }

    return {
      changeId,
      status: data.status,
    };
  } catch (err) {
    logger.warn({ changeId, err }, "Failed to fetch Forge change status");
    return null;
  }
}

/**
 * Determine if a Forge status allows issue completion.
 * Only "verified" and "archived" statuses allow completion.
 */
export function isForgeStatusCompletionAllowed(forgeStatus: string): boolean {
  return forgeStatus === "verified" || forgeStatus === "archived";
}

/**
 * Assert that a Forge-linked issue can be completed.
 * Throws ForgeCompletionGuardError if completion should be blocked.
 *
 * This function always fails closed - any error, missing config,
 * or unexpected status results in a block.
 */
export async function assertForgeIssueCompletionAllowed(
  issue: ForgeLinkedIssue,
  options: {
    config?: ForgeCompletionGuardConfig;
    fetchImpl?: typeof fetch;
    logActivity?: (input: {
      companyId: string;
      action: string;
      entityType: string;
      entityId: string;
      details: Record<string, unknown>;
    }) => Promise<void>;
  } = {}
): Promise<ForgeCompletionGuardResult> {
  const config = options.config ?? getConfig();

  // Validate link contract
  if (!issue.originId) {
    const error = new ForgeCompletionGuardError(
      "Cannot complete Forge-linked issue: missing originId (change_id)",
      "FORGE_LINK_MALFORMED",
      null,
      { issueId: issue.id, originKind: issue.originKind }
    );

    if (options.logActivity) {
      await options.logActivity({
        companyId: issue.companyId,
        action: "issue.completion_blocked",
        entityType: "issue",
        entityId: issue.id,
        details: {
          reason: "missing_origin_id",
          code: error.code,
          originKind: issue.originKind,
        },
      });
    }

    throw error;
  }

  // Check Forge configuration
  if (!config.forgeApiUrl) {
    const error = new ForgeCompletionGuardError(
      "Cannot complete Forge-linked issue: Forge API not configured",
      "FORGE_CONFIG_MISSING",
      issue.originId,
      { issueId: issue.id }
    );

    if (options.logActivity) {
      await options.logActivity({
        companyId: issue.companyId,
        action: "issue.completion_blocked",
        entityType: "issue",
        entityId: issue.id,
        details: {
          reason: "forge_api_url_missing",
          code: error.code,
          changeId: issue.originId,
        },
      });
    }

    throw error;
  }

  // Fetch Forge status
  const forgeStatus = await fetchForgeChangeStatus(
    issue.originId,
    config,
    options.fetchImpl
  );

  if (!forgeStatus) {
    const error = new ForgeCompletionGuardError(
      "Cannot complete Forge-linked issue: unable to verify Forge status",
      "FORGE_STATUS_UNAVAILABLE",
      issue.originId,
      { issueId: issue.id, forgeApiUrl: config.forgeApiUrl }
    );

    if (options.logActivity) {
      await options.logActivity({
        companyId: issue.companyId,
        action: "issue.completion_blocked",
        entityType: "issue",
        entityId: issue.id,
        details: {
          reason: "forge_status_fetch_failed",
          code: error.code,
          changeId: issue.originId,
          forgeApiUrl: config.forgeApiUrl,
        },
      });
    }

    throw error;
  }

  // Check if status allows completion
  if (!isForgeStatusCompletionAllowed(forgeStatus.status)) {
    const error = new ForgeCompletionGuardError(
      `Cannot complete Forge-linked issue: Forge status is "${forgeStatus.status}" (requires "verified" or "archived")`,
      "FORGE_STATUS_UNVERIFIED",
      issue.originId,
      { issueId: issue.id, forgeStatus: forgeStatus.status }
    );

    if (options.logActivity) {
      await options.logActivity({
        companyId: issue.companyId,
        action: "issue.completion_blocked",
        entityType: "issue",
        entityId: issue.id,
        details: {
          reason: "forge_status_unverified",
          code: error.code,
          changeId: issue.originId,
          forgeStatus: forgeStatus.status,
        },
      });
    }

    throw error;
  }

  // Completion allowed
  return {
    allowed: true,
    changeId: issue.originId,
    forgeStatus: forgeStatus.status,
  };
}

/**
 * Convenience function to check if an issue completion should be guarded.
 * Returns true only for Forge-linked issues transitioning TO "done" from another status.
 * Does NOT guard issues already marked "done" that receive status: "done" again (no-op updates).
 */
export function shouldGuardIssueCompletion(
  existingStatus: string,
  requestedStatus: string | undefined
): boolean {
  // Only guard actual transitions TO "done" (not already-done issues receiving "done" again)
  if (requestedStatus !== "done" || existingStatus === "done") {
    return false;
  }

  return true;
}
