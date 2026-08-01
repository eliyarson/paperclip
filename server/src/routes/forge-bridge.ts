/**
 * Forge Bridge Routes
 *
 * Paperclip-authenticated routes for Forge-Cerebro memory bridge operations:
 * - POST /companies/:companyId/forge/observations - Write Forge observations to Cerebro
 *
 * Authority: Cerebro remains the memory authority.
 * Paperclip owns auth, validation, company scope, redaction, and audit logging.
 *
 * @checkpoint paperclip-forge-cerebro-memory-bridge-v0
 * @requirements REQ-004, REQ-005, REQ-008, REQ-009, REQ-010
 */

import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import { projects } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { assertAuthenticated, assertCompanyAccess, getActorInfo } from "./authz.js";
import { unprocessable, forbidden, notFound } from "../errors.js";
import { logActivity } from "../services/index.js";
import type { Config } from "../config.js";
import {
  createForgeWritebackService,
  type WriteForgeObservationsInput,
} from "../services/forge-observation-writeback.js";
import type { ForgeEvent } from "../services/forge-observation-mapper.js";

/**
 * Validate project access - project must belong to the company.
 * @requirements REQ-005
 */
async function validateProjectAccess(
  db: Db,
  projectId: string | undefined,
  companyId: string,
): Promise<{ valid: boolean; error?: string }> {
  if (!projectId) {
    return { valid: true }; // No project to validate
  }

  const project = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  if (!project) {
    return {
      valid: false,
      error: `Project ${projectId} not found or does not belong to company ${companyId}`,
    };
  }

  return { valid: true };
}

/**
 * Helper to ensure string type from params (handles string | string[])
 */
function getParamString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

function requireAuthenticated(req: Request, _res: Response, next: NextFunction) {
  try {
    assertAuthenticated(req);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Create Forge bridge routes.
 */
export function forgeBridgeRoutes(db: Db, _config?: Config) {
  const router = Router();

  // Create the writeback service (config parsed from environment)
  const writebackService = createForgeWritebackService({} as Config);

  /**
   * POST /companies/:companyId/forge/observations
   * Write Forge observations to Cerebro.
   *
   * Request body: {
   *   forgeChangeId: string;
   *   events: ForgeEvent[];
   *   projectId?: string;
   *   agentId?: string;
   *   runId?: string;
   *   issueId?: string;
   * }
   *
   * @requirements REQ-004, REQ-005, REQ-008, REQ-010
   */
  router.post(
    "/companies/:companyId/forge/observations",
    requireAuthenticated,
    async (req: Request, res: Response) => {
      const companyId = getParamString(req.params.companyId);
      const actor = getActorInfo(req);

      if (!companyId) {
        throw unprocessable("Company ID is required");
      }

      // Verify company access
      assertCompanyAccess(req, companyId);

      // Validate project access if projectId provided (REQ-005)
      const projectId = req.body.projectId;
      if (projectId) {
        const projectValidation = await validateProjectAccess(db, projectId, companyId);
        if (!projectValidation.valid) {
          throw forbidden(projectValidation.error || "Project access denied");
        }
      }

      // Validate request body
      const forgeChangeId = req.body.forgeChangeId;
      const events = req.body.events;

      if (!forgeChangeId || typeof forgeChangeId !== "string") {
        throw unprocessable("forgeChangeId is required and must be a string");
      }

      if (!Array.isArray(events) || events.length === 0) {
        throw unprocessable("events is required and must be a non-empty array");
      }

      // Validate event count bounds
      if (events.length > 50) {
        throw unprocessable("Maximum 50 events allowed per request");
      }

      // Build input for writeback service
      const writeInput: WriteForgeObservationsInput = {
        companyId,
        forgeChangeId,
        events: events as ForgeEvent[],
        projectId: req.body.projectId,
        agentId: req.body.agentId,
        runId: req.body.runId,
        issueId: req.body.issueId,
        actor: {
          kind: actor.actorType === "user" ? "operator" : "agent",
          id: actor.actorId,
        },
      };

      // Write observations via service
      const result = await writebackService.writeObservations(writeInput, companyId);

      // Log activity
      if (result.success && result.acceptedCount > 0) {
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: "forge_observations_written",
          entityType: "forge_change",
          entityId: forgeChangeId,
          agentId: actor.agentId,
          runId: actor.runId,
          details: {
            forgeChangeId,
            eventCount: writeInput.events.length,
            acceptedCount: result.acceptedCount,
            rejectedCount: result.rejectedCount,
            degraded: result.degraded,
          },
        });

        logger.info({
          companyId,
          forgeChangeId,
          actorId: actor.actorId,
          acceptedCount: result.acceptedCount,
          rejectedCount: result.rejectedCount,
        }, "Forge observations written successfully");
      } else if (result.degraded) {
        logger.warn({
          companyId,
          forgeChangeId,
          actorId: actor.actorId,
          degraded: result.degraded,
          degradedReason: result.degradedReason,
          errorCode: result.errorCode,
        }, "Forge observations write returned degraded");
      } else if (!result.success) {
        logger.warn({
          companyId,
          forgeChangeId,
          actorId: actor.actorId,
          errorCode: result.errorCode,
          errorSummary: result.errorSummary,
        }, "Forge observations write failed");
      }

      // Return result
      // Note: We return 200 even for degraded results (fail-open behavior)
      // The degraded flag in the response indicates the actual status
      return res.status(200).json({
        success: result.success,
        acceptedCount: result.acceptedCount,
        rejectedCount: result.rejectedCount,
        rejectedReasons: result.rejectedReasons,
        degraded: result.degraded,
        degradedReason: result.degradedReason,
        errorCode: result.errorCode,
        errorSummary: result.errorSummary,
        audit: result.audit,
      });
    },
  );

  /**
   * GET /companies/:companyId/forge/config
   * Get Forge bridge configuration (redacted, for debugging).
   *
   * @requirements REQ-010 - redacted config only
   */
  router.get(
    "/companies/:companyId/forge/config",
    requireAuthenticated,
    async (req: Request, res: Response) => {
      const companyId = getParamString(req.params.companyId);

      if (!companyId) {
        throw unprocessable("Company ID is required");
      }

      // Verify company access
      assertCompanyAccess(req, companyId);

      // Return redacted config
      const config = writebackService.getConfig();

      return res.json({
        enabled: config.enabled,
        config: config.forgeBridge,
      });
    },
  );

  return router;
}
