/**
 * Forge Sync Service
 *
 * Provides bidirectional sync between Paperclip issues and Forge Charters.
 * Uses existing originKind="forge_charter" and originId=<change_id> as the v0 link contract.
 *
 * Authority model:
 * - Paperclip owns company, issue, project orchestration
 * - Forge owns Charter lifecycle, eval state, archive readiness
 * - This service mirrors and links; it does not certify completion
 */

import { logger } from "../middleware/logger.js";
import { conflict, HttpError, notFound } from "../errors.js";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { eq, and, ne } from "drizzle-orm";
import {
  fetchForgeChangeStatus,
  FORGE_LINKED_ORIGIN_KIND,
  type ForgeCompletionGuardConfig,
} from "./forge-completion-guard.js";

export interface ForgeLinkInput {
  issueId: string;
  changeId: string;
  companyId: string;
}

export interface ForgeLinkResult {
  issueId: string;
  changeId: string;
  linked: boolean;
  previousChangeId?: string | null;
}

export interface ForgeStatusResult {
  issueId: string;
  changeId: string;
  forgeStatus: string | null;
  linkActive: boolean;
  error?: string;
}

export interface ForgeLinkedIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  originKind: string | null;
  originId: string | null;
}

export interface ForgeSyncIssueInput {
  companyId: string;
  changeId: string;
  title?: string;
  description?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
}

export interface ForgeSyncIssueResult {
  issue: ForgeLinkedIssueSummary;
  created: boolean;
  changeId: string;
}

export class ForgeSyncError extends HttpError {
  constructor(
    message: string,
    public readonly code: string,
    public readonly changeId: string | null,
    status: number = 409,
    details?: Record<string, unknown>
  ) {
    super(status, message, { code, changeId, ...details });
  }
}

function getConfig(): ForgeCompletionGuardConfig {
  return {
    forgeApiUrl: process.env.FORGE_API_URL,
    forgeApiToken: process.env.FORGE_API_TOKEN,
  };
}

/**
 * Fetch Forge status for a change_id.
 * Returns null on any error to support fail-closed behavior.
 */
export async function fetchForgeStatus(
  changeId: string,
  config?: ForgeCompletionGuardConfig,
  fetchImpl?: typeof fetch
): Promise<{ status: string } | null> {
  const effectiveConfig = config ?? getConfig();
  const result = await fetchForgeChangeStatus(changeId, effectiveConfig, fetchImpl);
  return result ? { status: result.status } : null;
}

/**
 * Check if a change_id is already linked to an active issue in the company.
 * Returns the linked issue if found, null otherwise.
 */
export async function findLinkedIssueByChangeId(
  db: Db,
  companyId: string,
  changeId: string,
  excludeIssueId?: string
): Promise<ForgeLinkedIssueSummary | null> {
  const conditions = [
    eq(issues.companyId, companyId),
    eq(issues.originKind, FORGE_LINKED_ORIGIN_KIND),
    eq(issues.originId, changeId),
    ne(issues.status, "cancelled"),
  ];

  if (excludeIssueId) {
    conditions.push(ne(issues.id, excludeIssueId));
  }

  const result = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      originKind: issues.originKind,
      originId: issues.originId,
    })
    .from(issues)
    .where(and(...conditions))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Link an existing issue to a Forge Charter.
 * Rejects if another active issue already links to the same change_id.
 */
export async function linkIssueToForge(
  db: Db,
  input: ForgeLinkInput
): Promise<ForgeLinkResult> {
  const { issueId, changeId, companyId } = input;

  // Verify the issue exists and belongs to the company
  const issueResult = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      originKind: issues.originKind,
      originId: issues.originId,
      status: issues.status,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .limit(1);

  const issue = issueResult[0];
  if (!issue) {
    throw notFound("Issue not found");
  }

  if (issue.status === "cancelled") {
    throw new ForgeSyncError(
      "Cannot link cancelled issue to Forge Charter",
      "FORGE_LINK_CANCELLED_ISSUE",
      changeId,
      409
    );
  }

  // Check for conflicting mappings
  const existingLink = await findLinkedIssueByChangeId(db, companyId, changeId, issueId);
  if (existingLink) {
    throw new ForgeSyncError(
      `Change ${changeId} is already linked to issue ${existingLink.identifier ?? existingLink.id}`,
      "FORGE_LINK_CONFLICT",
      changeId,
      409,
      { conflictingIssueId: existingLink.id }
    );
  }

  const previousChangeId = issue.originId;

  // Update the issue with the Forge link
  await db
    .update(issues)
    .set({
      originKind: FORGE_LINKED_ORIGIN_KIND,
      originId: changeId,
      updatedAt: new Date(),
    })
    .where(eq(issues.id, issueId));

  logger.info(
    { issueId, changeId, companyId, previousChangeId },
    "Issue linked to Forge Charter"
  );

  return {
    issueId,
    changeId,
    linked: true,
    previousChangeId,
  };
}

/**
 * Get Forge status for a linked issue.
 * Fetches live status from Forge over HTTP.
 */
export async function getLinkedIssueForgeStatus(
  db: Db,
  issueId: string,
  companyId: string,
  config?: ForgeCompletionGuardConfig,
  fetchImpl?: typeof fetch
): Promise<ForgeStatusResult> {
  // Verify the issue exists and belongs to the company
  const issueResult = await db
    .select({
      id: issues.id,
      originKind: issues.originKind,
      originId: issues.originId,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .limit(1);

  const issue = issueResult[0];
  if (!issue) {
    throw notFound("Issue not found");
  }

  if (issue.originKind !== FORGE_LINKED_ORIGIN_KIND || !issue.originId) {
    return {
      issueId,
      changeId: issue.originId ?? "",
      forgeStatus: null,
      linkActive: false,
      error: "Issue is not linked to a Forge Charter",
    };
  }

  const effectiveConfig = config ?? getConfig();

  // Fail closed: if Forge config is missing, report error without exposing config state
  if (!effectiveConfig.forgeApiUrl) {
    return {
      issueId,
      changeId: issue.originId,
      forgeStatus: null,
      linkActive: true,
      error: "Forge status unavailable",
    };
  }

  const forgeStatus = await fetchForgeStatus(issue.originId, effectiveConfig, fetchImpl);

  if (!forgeStatus) {
    return {
      issueId,
      changeId: issue.originId,
      forgeStatus: null,
      linkActive: true,
      error: "Failed to fetch Forge status",
    };
  }

  return {
    issueId,
    changeId: issue.originId,
    forgeStatus: forgeStatus.status,
    linkActive: true,
  };
}

/**
 * Resolve a linked issue by company and change_id.
 * Returns null if no active linked issue exists.
 */
export async function resolveIssueByChangeId(
  db: Db,
  companyId: string,
  changeId: string
): Promise<ForgeLinkedIssueSummary | null> {
  const result = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      originKind: issues.originKind,
      originId: issues.originId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, FORGE_LINKED_ORIGIN_KIND),
        eq(issues.originId, changeId),
        ne(issues.status, "cancelled")
      )
    )
    .limit(1);

  return result[0] ?? null;
}

/**
 * Sync a Forge Charter to a Paperclip issue.
 * Creates a new issue if none exists, otherwise returns the existing linked issue.
 */
export async function syncForgeCharterToIssue(
  db: Db,
  input: ForgeSyncIssueInput
): Promise<ForgeSyncIssueResult> {
  const { companyId, changeId, title, description, createdByAgentId, createdByUserId } = input;

  // Check if an issue already exists for this change_id
  const existingIssue = await resolveIssueByChangeId(db, companyId, changeId);
  if (existingIssue) {
    return {
      issue: existingIssue,
      created: false,
      changeId,
    };
  }

  // Fetch Forge status to validate the change exists and get metadata
  const effectiveConfig = getConfig();
  const forgeStatus = await fetchForgeStatus(changeId, effectiveConfig);

  // Fail closed: we still create the issue even if Forge is unavailable,
  // but we log a warning. The link contract is what matters.
  if (!forgeStatus) {
    logger.warn(
      { changeId, companyId },
      "Creating linked issue without Forge status verification"
    );
  }

  // Create the issue with Forge link
  const issueTitle = title ?? `Forge: ${changeId}`;
  const now = new Date();

  const insertResult = await db
    .insert(issues)
    .values({
      companyId,
      title: issueTitle,
      description: description ?? null,
      status: "backlog",
      originKind: FORGE_LINKED_ORIGIN_KIND,
      originId: changeId,
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByAgentId: createdByAgentId ?? null,
      createdByUserId: createdByUserId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      originKind: issues.originKind,
      originId: issues.originId,
    });

  const newIssue = insertResult[0];
  if (!newIssue) {
    throw new ForgeSyncError(
      "Failed to create linked issue",
      "FORGE_SYNC_CREATE_FAILED",
      changeId,
      500
    );
  }

  logger.info(
    { issueId: newIssue.id, changeId, companyId },
    "Created Paperclip issue for Forge Charter"
  );

  return {
    issue: newIssue,
    created: true,
    changeId,
  };
}

/**
 * Unlink an issue from its Forge Charter.
 * Preserves the issue but removes the originKind/originId link.
 */
export async function unlinkIssueFromForge(
  db: Db,
  issueId: string,
  companyId: string
): Promise<{ issueId: string; previousChangeId: string | null; unlinked: boolean }> {
  // Verify the issue exists and belongs to the company
  const issueResult = await db
    .select({
      id: issues.id,
      originKind: issues.originKind,
      originId: issues.originId,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .limit(1);

  const issue = issueResult[0];
  if (!issue) {
    throw notFound("Issue not found");
  }

  const previousChangeId = issue.originId;

  if (issue.originKind !== FORGE_LINKED_ORIGIN_KIND) {
    return {
      issueId,
      previousChangeId: null,
      unlinked: false,
    };
  }

  await db
    .update(issues)
    .set({
      originKind: "manual",
      originId: null,
      updatedAt: new Date(),
    })
    .where(eq(issues.id, issueId));

  logger.info(
    { issueId, previousChangeId, companyId },
    "Issue unlinked from Forge Charter"
  );

  return {
    issueId,
    previousChangeId,
    unlinked: true,
  };
}
