/**
 * Cerebro Learning Surfaces Routes
 *
 * Board/operator API routes for company-scoped learning candidate operations:
 * - List candidates (with filters, pagination)
 * - Get candidate detail
 * - Promote/dismiss/supersede actions
 *
 * Authority: Cerebro remains the memory authority.
 * Paperclip owns auth, validation, company scope, and audit logging.
 *
 * @checkpoint paperclip-cerebro-learning-surfaces-v0
 * @task TASK-003
 */

import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  cerebroLearningCandidateListRequestSchema,
  cerebroLearningCandidateDetailRequestSchema,
  cerebroLearningCandidateActionRequestSchema,
  type CerebroLearningCandidateListRequest,
  type CerebroLearningCandidateDetailRequest,
  type CerebroLearningCandidateActionRequest,
} from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { unprocessable } from "../errors.js";
import { logActivity } from "../services/index.js";
import {
  createCerebroLearningClient,
  parseCerebroLearningClientConfig,
  type CerebroLearningClient,
} from "../services/cerebro-learning-surfaces.js";
import type { Config } from "../config.js";

function requireBoard(req: Request, res: Response, next: NextFunction) {
  try {
    const maybeMiddleware = assertBoard as unknown as (
      req: Request,
      res?: Response,
      next?: NextFunction,
    ) => void;
    if (maybeMiddleware.length >= 3) {
      maybeMiddleware(req, res, next);
      return;
    }
    assertBoard(req);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Helper to ensure string type from params (handles string | string[])
 */
function getParamString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

function getActorId(actor: ReturnType<typeof getActorInfo>): string {
  return actor.actorId || "paperclip-operator";
}

/**
 * Create learning surfaces routes.
 */
export function cerebroLearningRoutes(db: Db, _config?: Config) {
  const router = Router();

  // Parse Cerebro learning client config from environment
  // Config parameter is kept for API compatibility but values are read from env
  const learningClientConfig = parseCerebroLearningClientConfig({} as Config);
  const learningClient: CerebroLearningClient = createCerebroLearningClient(learningClientConfig);

  /**
   * GET /companies/:companyId/learning-candidates
   * List learning candidates for a company.
   */
  router.get(
    "/companies/:companyId/learning-candidates",
    requireBoard,
    async (req: Request, res: Response) => {
      const companyId = getParamString(req.params.companyId);
      const actor = getActorInfo(req);
      const actorId = getActorId(actor);

      if (!companyId) {
        throw unprocessable("Company ID is required");
      }

      // Verify company access
      assertCompanyAccess(req, companyId);

      // Build request from query params
      const listRequest: CerebroLearningCandidateListRequest = {
        companyId,
        projectId: getParamString(req.query.projectId as string | string[] | undefined),
        agentId: getParamString(req.query.agentId as string | string[] | undefined),
        runId: getParamString(req.query.runId as string | string[] | undefined),
        issueId: getParamString(req.query.issueId as string | string[] | undefined),
        status: getParamString(req.query.status as string | string[] | undefined) as CerebroLearningCandidateListRequest["status"],
        limit: req.query.limit ? parseInt(getParamString(req.query.limit as string | string[]) ?? "20", 10) : 20,
        offset: req.query.offset ? parseInt(getParamString(req.query.offset as string | string[]) ?? "0", 10) : 0,
        sortBy: (getParamString(req.query.sortBy as string | string[] | undefined) as CerebroLearningCandidateListRequest["sortBy"]) || "createdAt",
        sortOrder: (getParamString(req.query.sortOrder as string | string[] | undefined) as CerebroLearningCandidateListRequest["sortOrder"]) || "desc",
      };

      // Validate request
      const validationResult = cerebroLearningCandidateListRequestSchema.safeParse(listRequest);
      if (!validationResult.success) {
        throw unprocessable("Invalid request: " + validationResult.error.message);
      }

      // Fetch from Cerebro
      const result = await learningClient.listCandidates(listRequest);

      // Log activity for degraded state
      if (result.degraded || !result.success) {
        logger.warn({
          companyId,
          actorId,
          degraded: result.degraded,
          errorCode: result.errorCode,
        }, "Learning candidates list returned degraded/error");
      }

      // Return result (degraded state is included in response)
      return res.json(result);
    },
  );

  /**
   * GET /api/companies/:companyId/learning-candidates/:candidateId
   * Get learning candidate detail.
   */
  router.get(
    "/companies/:companyId/learning-candidates/:candidateId",
    requireBoard,
    async (req: Request, res: Response) => {
      const companyId = getParamString(req.params.companyId);
      const candidateId = getParamString(req.params.candidateId);
      const actor = getActorInfo(req);
      const actorId = getActorId(actor);

      if (!companyId) {
        throw unprocessable("Company ID is required");
      }
      if (!candidateId) {
        throw unprocessable("Candidate ID is required");
      }

      // Verify company access
      assertCompanyAccess(req, companyId);

      // Build request
      const detailRequest: CerebroLearningCandidateDetailRequest = {
        candidateId,
        companyId,
      };

      // Validate request
      const validationResult = cerebroLearningCandidateDetailRequestSchema.safeParse(detailRequest);
      if (!validationResult.success) {
        throw unprocessable("Invalid request: " + validationResult.error.message);
      }

      // Fetch from Cerebro
      const result = await learningClient.getCandidateDetail(detailRequest);

      // Log activity for degraded state
      if (result.degraded || !result.success) {
        logger.warn({
          companyId,
          candidateId,
          actorId,
          degraded: result.degraded,
          errorCode: result.errorCode,
        }, "Learning candidate detail returned degraded/error");
      }

      // Return result
      return res.json(result);
    },
  );

  /**
   * POST /api/companies/:companyId/learning-candidates/:candidateId/actions
   * Perform action on learning candidate (promote/dismiss/supersede).
   */
  router.post(
    "/companies/:companyId/learning-candidates/:candidateId/actions",
    requireBoard,
    async (req: Request, res: Response) => {
      const companyId = getParamString(req.params.companyId);
      const candidateId = getParamString(req.params.candidateId);
      const actor = getActorInfo(req);
      const actorId = getActorId(actor);

      if (!companyId) {
        throw unprocessable("Company ID is required");
      }
      if (!candidateId) {
        throw unprocessable("Candidate ID is required");
      }

      // Verify company access
      assertCompanyAccess(req, companyId);

      // Build request
      const actionRequest: CerebroLearningCandidateActionRequest = {
        candidateId,
        companyId,
        action: req.body.action,
        reason: req.body.reason,
        supersededCandidateId: req.body.supersededCandidateId,
        idempotencyKey: req.body.idempotencyKey,
      };

      // Validate request
      const validationResult = cerebroLearningCandidateActionRequestSchema.safeParse(actionRequest);
      if (!validationResult.success) {
        throw unprocessable("Invalid request: " + validationResult.error.message);
      }

      // Validate action type
      const validActions = ["promote", "dismiss", "supersede"] as const;
      if (!validActions.includes(actionRequest.action)) {
        throw unprocessable(`Invalid action: ${actionRequest.action}. Must be one of: ${validActions.join(", ")}`);
      }

      // Perform action via Cerebro
      const result = await learningClient.performAction(actionRequest, actorId);

      // Log activity
      if (result.success) {
        await logActivity(db, {
          companyId,
          actorType: actor.actorType || "user",
          actorId,
          action: `learning_candidate_${actionRequest.action}`,
          entityType: "learning_candidate",
          entityId: candidateId,
          agentId: actor.agentId,
          runId: actor.runId,
          details: {
            action: actionRequest.action,
            reason: actionRequest.reason,
            supersededCandidateId: actionRequest.supersededCandidateId,
            audit: result.audit,
          },
        });

        logger.info({
          companyId,
          candidateId,
          actorId,
          action: actionRequest.action,
        }, "Learning candidate action performed successfully");
      } else {
        logger.warn({
          companyId,
          candidateId,
          actorId,
          action: actionRequest.action,
          degraded: result.degraded,
          errorCode: result.errorCode,
        }, "Learning candidate action failed");
      }

      // Return result
      return res.json(result);
    },
  );

  return router;
}
