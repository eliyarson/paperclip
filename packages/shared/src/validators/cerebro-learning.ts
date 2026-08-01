/**
 * Cerebro Learning Candidate validators and types.
 *
 * Defines bounded DTOs for learning candidate list/detail/action request/response:
 * - Source metadata, bounded source snippets, audit metadata
 * - Lifecycle status, degraded state, supersession fields
 * - Company/project/agent/run/issue scope fields
 * - No Forge-specific fields
 *
 * @checkpoint paperclip-cerebro-learning-surfaces-v0
 * @tasks TASK-001, TASK-002
 */

import { z } from "zod";

// =============================================================================
// Learning Candidate Lifecycle Status
// =============================================================================

export const CEREBRO_LEARNING_CANDIDATE_STATUSES = [
  "pending",
  "promoted",
  "dismissed",
  "superseded",
  "unavailable",
  "degraded",
] as const;

export const cerebroLearningCandidateStatusSchema = z.enum(
  CEREBRO_LEARNING_CANDIDATE_STATUSES
);

export type CerebroLearningCandidateStatus = z.infer<
  typeof cerebroLearningCandidateStatusSchema
>;

// =============================================================================
// Learning Candidate Action Types
// =============================================================================

export const CEREBRO_LEARNING_CANDIDATE_ACTIONS = [
  "promote",
  "dismiss",
  "supersede",
] as const;

export const cerebroLearningCandidateActionSchema = z.enum(
  CEREBRO_LEARNING_CANDIDATE_ACTIONS
);

export type CerebroLearningCandidateAction = z.infer<
  typeof cerebroLearningCandidateActionSchema
>;

// =============================================================================
// Source Metadata (bounded, no secrets)
// =============================================================================

/**
 * Source metadata for a learning candidate.
 * Contains identifiers linking back to Paperclip entities.
 * No Forge-specific fields.
 */
export const cerebroLearningSourceMetadataSchema = z.object({
  // Source identifiers (link back to Paperclip)
  sourceType: z.string().min(1).max(100),
  sourceId: z.string().min(1).max(500),

  // Paperclip scope identifiers
  companyId: z.string().min(1).max(100),
  projectId: z.string().min(1).max(100).optional(),
  agentId: z.string().min(1).max(100).optional(),
  runId: z.string().min(1).max(100).optional(),
  issueId: z.string().min(1).max(100).optional(),
  changeId: z.string().min(1).max(100).optional(),

  // Source timestamps
  observedAt: z.string().datetime().optional(),
  recordedAt: z.string().datetime(),

  // Source type classification
  observationType: z.string().min(1).max(100).optional(),
});

export type CerebroLearningSourceMetadata = z.infer<
  typeof cerebroLearningSourceMetadataSchema
>;

// =============================================================================
// Bounded Source Snippets
// =============================================================================

/**
 * Bounded source snippet for display.
 * Size limits prevent unbounded payload exposure.
 */
export const cerebroLearningSourceSnippetSchema = z.object({
  // Snippet content (bounded)
  content: z.string().min(1).max(2000),

  // Snippet metadata
  language: z.string().max(50).optional(),
  filePath: z.string().max(500).optional(),
  lineStart: z.number().int().nonnegative().optional(),
  lineEnd: z.number().int().nonnegative().optional(),

  // Context around the snippet
  contextBefore: z.string().max(500).optional(),
  contextAfter: z.string().max(500).optional(),
});

export type CerebroLearningSourceSnippet = z.infer<
  typeof cerebroLearningSourceSnippetSchema
>;

// =============================================================================
// Audit Metadata
// =============================================================================

/**
 * Audit metadata for learning candidate actions.
 * Records actor, timestamps, and action outcomes.
 */
export const cerebroLearningAuditMetadataSchema = z.object({
  // Actor information
  actorId: z.string().min(1).max(100),
  actorType: z.enum(["operator", "system", "agent"]),
  companyId: z.string().min(1).max(100),

  // Action information
  action: cerebroLearningCandidateActionSchema,
  actionStatus: z.enum(["pending", "in_progress", "success", "failure"]),

  // Timestamps
  requestedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),

  // Related source IDs for traceability
  relatedSourceIds: z.array(z.string().min(1).max(500)).max(10).optional(),

  // Error information (when action fails)
  errorCode: z.string().max(100).optional(),
  errorSummary: z.string().max(500).optional(),
});

export type CerebroLearningAuditMetadata = z.infer<
  typeof cerebroLearningAuditMetadataSchema
>;

// =============================================================================
// Supersession Fields
// =============================================================================

/**
 * Supersession metadata for tracking candidate replacement.
 */
export const cerebroLearningSupersessionSchema = z.object({
  // The candidate that superseded this one
  supersededBy: z.string().min(1).max(100).optional(),

  // The candidate that this one superseded
  supersedes: z.string().min(1).max(100).optional(),

  // Supersession reason
  reason: z.string().min(1).max(500).optional(),

  // Supersession timestamp
  supersededAt: z.string().datetime().optional(),
});

export type CerebroLearningSupersession = z.infer<
  typeof cerebroLearningSupersessionSchema
>;

// =============================================================================
// Degraded State
// =============================================================================

/**
 * Degraded state metadata for when Cerebro is unavailable.
 */
export const cerebroLearningDegradedStateSchema = z.object({
  // Whether the candidate data is degraded/stale
  isDegraded: z.boolean(),

  // Reason for degradation
  reason: z.enum([
    "cerebro_unavailable",
    "timeout",
    "partial_data",
    "sync_error",
  ]),

  // Human-readable explanation
  message: z.string().max(500).optional(),

  // When the degradation was detected
  detectedAt: z.string().datetime().optional(),

  // Last successful sync timestamp
  lastSuccessfulSyncAt: z.string().datetime().optional(),
});

export type CerebroLearningDegradedState = z.infer<
  typeof cerebroLearningDegradedStateSchema
>;

// =============================================================================
// Learning Candidate (list item)
// =============================================================================

/**
 * Learning candidate list item.
 * Bounded fields suitable for list views.
 */
export const cerebroLearningCandidateListItemSchema = z.object({
  // Candidate identifier
  id: z.string().min(1).max(100),

  // Lifecycle status
  status: cerebroLearningCandidateStatusSchema,

  // Source metadata (bounded)
  source: cerebroLearningSourceMetadataSchema,

  // Preview content (bounded)
  title: z.string().min(1).max(200),
  preview: z.string().min(1).max(1000),

  // Confidence/score if available
  confidence: z.number().min(0).max(1).optional(),

  // Timestamps
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),

  // Degraded state
  degraded: cerebroLearningDegradedStateSchema.optional(),
});

export type CerebroLearningCandidateListItem = z.infer<
  typeof cerebroLearningCandidateListItemSchema
>;

// =============================================================================
// Learning Candidate (detail)
// =============================================================================

/**
 * Full learning candidate detail.
 * Includes all bounded fields for detail view.
 */
export const cerebroLearningCandidateDetailSchema = z.object({
  // Candidate identifier
  id: z.string().min(1).max(100),

  // Lifecycle status
  status: cerebroLearningCandidateStatusSchema,

  // Source metadata
  source: cerebroLearningSourceMetadataSchema,

  // Full content (bounded)
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000).optional(),

  // Source snippets (bounded array)
  snippets: z.array(cerebroLearningSourceSnippetSchema).max(10).optional(),

  // Confidence/score
  confidence: z.number().min(0).max(1).optional(),

  // Timestamps
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),

  // Audit trail (last action)
  lastAction: cerebroLearningAuditMetadataSchema.optional(),

  // Supersession info
  supersession: cerebroLearningSupersessionSchema.optional(),

  // Degraded state
  degraded: cerebroLearningDegradedStateSchema.optional(),

  // Related candidate IDs
  relatedCandidateIds: z.array(z.string().min(1).max(100)).max(10).optional(),
});

export type CerebroLearningCandidateDetail = z.infer<
  typeof cerebroLearningCandidateDetailSchema
>;

// =============================================================================
// List Request/Response
// =============================================================================

/**
 * Learning candidate list request.
 * Company-scoped with optional filters.
 */
export const cerebroLearningCandidateListRequestSchema = z.object({
  // Required company scope
  companyId: z.string().min(1).max(100),

  // Optional scope filters
  projectId: z.string().min(1).max(100).optional(),
  agentId: z.string().min(1).max(100).optional(),
  runId: z.string().min(1).max(100).optional(),
  issueId: z.string().min(1).max(100).optional(),

  // Status filter
  status: cerebroLearningCandidateStatusSchema.optional(),

  // Pagination
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),

  // Sorting
  sortBy: z.enum(["createdAt", "updatedAt", "confidence"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type CerebroLearningCandidateListRequest = z.infer<
  typeof cerebroLearningCandidateListRequestSchema
>;

/**
 * Learning candidate list response.
 */
export const cerebroLearningCandidateListResponseSchema = z.object({
  success: z.boolean(),

  // Results
  candidates: z.array(cerebroLearningCandidateListItemSchema),

  // Pagination
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),

  // Degraded state for the entire list
  degraded: cerebroLearningDegradedStateSchema.optional(),

  // Error info (when success is false)
  errorCode: z.string().max(100).optional(),
  errorSummary: z.string().max(500).optional(),
});

export type CerebroLearningCandidateListResponse = z.infer<
  typeof cerebroLearningCandidateListResponseSchema
>;

// =============================================================================
// Detail Request/Response
// =============================================================================

/**
 * Learning candidate detail request.
 */
export const cerebroLearningCandidateDetailRequestSchema = z.object({
  // Candidate identifier
  candidateId: z.string().min(1).max(100),

  // Company scope (for access validation)
  companyId: z.string().min(1).max(100),
});

export type CerebroLearningCandidateDetailRequest = z.infer<
  typeof cerebroLearningCandidateDetailRequestSchema
>;

/**
 * Learning candidate detail response.
 */
export const cerebroLearningCandidateDetailResponseSchema = z.object({
  success: z.boolean(),

  // Full candidate detail
  candidate: cerebroLearningCandidateDetailSchema.optional(),

  // Degraded state
  degraded: cerebroLearningDegradedStateSchema.optional(),

  // Error info
  errorCode: z.string().max(100).optional(),
  errorSummary: z.string().max(500).optional(),
});

export type CerebroLearningCandidateDetailResponse = z.infer<
  typeof cerebroLearningCandidateDetailResponseSchema
>;

// =============================================================================
// Action Request/Response (Promote/Dismiss/Supersede)
// =============================================================================

/**
 * Learning candidate action request.
 */
export const cerebroLearningCandidateActionRequestSchema = z.object({
  // Candidate identifier
  candidateId: z.string().min(1).max(100),

  // Company scope (for access validation)
  companyId: z.string().min(1).max(100),

  // Action to perform
  action: cerebroLearningCandidateActionSchema,

  // Action parameters
  reason: z.string().min(1).max(500).optional(),

  // For supersede action: the candidate being superseded
  supersededCandidateId: z.string().min(1).max(100).optional(),

  // Idempotency key
  idempotencyKey: z.string().min(1).max(100).optional(),
});

export type CerebroLearningCandidateActionRequest = z.infer<
  typeof cerebroLearningCandidateActionRequestSchema
>;

/**
 * Learning candidate action response.
 */
export const cerebroLearningCandidateActionResponseSchema = z.object({
  success: z.boolean(),

  // Updated candidate (if action succeeded)
  candidate: cerebroLearningCandidateDetailSchema.optional(),

  // Action audit metadata
  audit: cerebroLearningAuditMetadataSchema.optional(),

  // Degraded state
  degraded: cerebroLearningDegradedStateSchema.optional(),

  // Error info
  errorCode: z.string().max(100).optional(),
  errorSummary: z.string().max(500).optional(),
});

export type CerebroLearningCandidateActionResponse = z.infer<
  typeof cerebroLearningCandidateActionResponseSchema
>;
