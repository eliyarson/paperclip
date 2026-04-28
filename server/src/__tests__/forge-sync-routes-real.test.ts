import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// =============================================================================
// FORGE SYNC ROUTE TESTS - Real Express/Supertest with Service Mocking
// =============================================================================

// Track mock calls for verification
const mockCalls = {
  linkIssueToForge: [] as any[],
  getLinkedIssueForgeStatus: [] as any[],
  resolveIssueByChangeId: [] as any[],
  syncForgeCharterToIssue: [] as any[],
};

// Mock the forge-sync service module
vi.mock("../services/forge-sync.js", () => ({
  linkIssueToForge: vi.fn(async (db: any, input: any) => {
    mockCalls.linkIssueToForge.push({ db, input });

    // Simulate conflict if change already linked
    if (input.changeId === "conflict-change") {
      const error = new Error(`Change ${input.changeId} is already linked to issue PAP-777`) as any;
      error.status = 409;
      error.code = "FORGE_LINK_CONFLICT";
      error.changeId = input.changeId;
      throw error;
    }

    // Simulate not found
    if (input.issueId === "non-existent") {
      const error = new Error("Issue not found") as any;
      error.status = 404;
      throw error;
    }

    // Simulate cancelled issue
    if (input.issueId === "cancelled-issue") {
      const error = new Error("Cannot link cancelled issue to Forge Charter") as any;
      error.status = 409;
      error.code = "FORGE_LINK_CANCELLED_ISSUE";
      throw error;
    }

    return {
      issueId: input.issueId,
      changeId: input.changeId,
      linked: true,
      previousChangeId: null,
    };
  }),

  getLinkedIssueForgeStatus: vi.fn(async (db: any, issueId: string, companyId: string) => {
    mockCalls.getLinkedIssueForgeStatus.push({ db, issueId, companyId });

    // Simulate not found
    if (issueId === "non-existent") {
      const error = new Error("Issue not found") as any;
      error.status = 404;
      throw error;
    }

    // Simulate unlinked issue
    if (issueId === "unlinked-issue") {
      return {
        issueId,
        changeId: "",
        forgeStatus: null,
        linkActive: false,
        error: "Issue is not linked to a Forge Charter",
      };
    }

    // Simulate linked issue with Forge status
    return {
      issueId,
      changeId: "change-1",
      forgeStatus: "verified",
      linkActive: true,
    };
  }),

  resolveIssueByChangeId: vi.fn(async (db: any, companyId: string, changeId: string) => {
    mockCalls.resolveIssueByChangeId.push({ db, companyId, changeId });

    // Simulate no linked issue
    if (changeId === "unknown-change") {
      return null;
    }

    return {
      id: "issue-123",
      identifier: "PAP-123",
      title: "Linked Issue",
      status: "in_progress",
      originKind: "forge_charter",
      originId: changeId,
    };
  }),

  syncForgeCharterToIssue: vi.fn(async (db: any, input: any) => {
    mockCalls.syncForgeCharterToIssue.push({ db, input });

    // Simulate existing issue
    if (input.changeId === "existing-change") {
      return {
        issue: {
          id: "existing-issue",
          identifier: "PAP-456",
          title: "Existing Linked Issue",
          status: "in_progress",
          originKind: "forge_charter",
          originId: input.changeId,
        },
        created: false,
        changeId: input.changeId,
      };
    }

    // Simulate new issue creation
    return {
      issue: {
        id: "new-issue-id",
        identifier: "PAP-789",
        title: input.title || `Forge: ${input.changeId}`,
        status: "backlog",
        originKind: "forge_charter",
        originId: input.changeId,
      },
      created: true,
      changeId: input.changeId,
    };
  }),

  ForgeSyncError: class ForgeSyncError extends Error {
    code: string;
    changeId: string | null;
    status: number;
    constructor(message: string, code: string, changeId: string | null, status: number = 409) {
      super(message);
      this.code = code;
      this.changeId = changeId;
      this.status = status;
    }
  },
}));

// Mock other required modules
vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    // Override with our mocked forge-sync functions
    linkIssueToForge: (await import("../services/forge-sync.js")).linkIssueToForge,
    getLinkedIssueForgeStatus: (await import("../services/forge-sync.js")).getLinkedIssueForgeStatus,
    resolveIssueByChangeId: (await import("../services/forge-sync.js")).resolveIssueByChangeId,
    syncForgeCharterToIssue: (await import("../services/forge-sync.js")).syncForgeCharterToIssue,
    ForgeSyncError: (await import("../services/forge-sync.js")).ForgeSyncError,
  };
});

// Mock minimal required dependencies
vi.mock("@paperclipai/db", () => ({
  issues: {},
  labels: {},
  activityLog: {},
  agentWakeupRequests: {},
  agents: {},
  approvals: {},
  assets: {},
  companies: {},
  companyMemberships: {},
  documents: {},
  goals: {},
  heartbeatRuns: {},
  executionWorkspaces: {},
  issueApprovals: {},
  issueAttachments: {},
  issueInboxArchives: {},
  issueLabels: {},
  issueRelations: {},
  issueComments: {},
  issueDocuments: {},
  issueReadStates: {},
  issueThreadInteractions: {},
  issueExecutionDecisions: {},
  projectWorkspaces: {},
  projects: {},
  feedbackExports: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  ne: vi.fn(),
  or: vi.fn(),
  inArray: vi.fn(),
  notInArray: vi.fn(),
  isNull: vi.fn(),
  gt: vi.fn(),
  lt: vi.fn(),
  asc: vi.fn(),
  desc: vi.fn(),
  sql: vi.fn(),
  getTableColumns: vi.fn(() => ({})),
}));

vi.mock("@paperclipai/shared", () => ({
  extractAgentMentionIds: vi.fn(() => []),
  extractProjectMentionIds: vi.fn(() => []),
  isUuidLike: vi.fn(() => true),
  addIssueCommentSchema: { parse: (v: any) => v },
  acceptIssueThreadInteractionSchema: { parse: (v: any) => v },
  createIssueAttachmentMetadataSchema: { parse: (v: any) => v },
  createIssueThreadInteractionSchema: { parse: (v: any) => v },
  createIssueWorkProductSchema: { parse: (v: any) => v },
  createIssueLabelSchema: { parse: (v: any) => v },
  checkoutIssueSchema: { parse: (v: any) => v },
  createChildIssueSchema: { parse: (v: any) => v },
  createIssueSchema: { parse: (v: any) => v },
  feedbackTargetTypeSchema: { parse: (v: any) => v },
  feedbackTraceStatusSchema: { parse: (v: any) => v },
  feedbackVoteValueSchema: { parse: (v: any) => v },
  upsertIssueFeedbackVoteSchema: { parse: (v: any) => v },
  linkIssueApprovalSchema: { parse: (v: any) => v },
  issueDocumentKeySchema: { parse: (v: any) => v, safeParse: (v: any) => ({ success: true, data: v }) },
  ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY: "continuation_summary",
  rejectIssueThreadInteractionSchema: { parse: (v: any) => v },
  restoreIssueDocumentRevisionSchema: { parse: (v: any) => v },
  respondIssueThreadInteractionSchema: { parse: (v: any) => v },
  updateIssueWorkProductSchema: { parse: (v: any) => v },
  upsertIssueDocumentSchema: { parse: (v: any) => v },
  updateIssueSchema: {
    extend: () => ({ parse: (v: any) => v, safeParse: (v: any) => ({ success: true, data: v }) }),
    parse: (v: any) => v,
    safeParse: (v: any) => ({ success: true, data: v }),
  },
  getClosedIsolatedExecutionWorkspaceMessage: vi.fn(() => "Workspace is closed"),
  isClosedIsolatedExecutionWorkspace: vi.fn(() => false),
  ExecutionWorkspace: {},
  IssueBlockerAttention: {},
  IssueRelationIssueSummary: {},
}));

// Create Express app with routes
async function createTestApp() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });

  // Mock DB
  const mockDb = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
    transaction: vi.fn(async (fn: any) => fn(mockDb)),
  };

  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("forge sync routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCalls.linkIssueToForge = [];
    mockCalls.getLinkedIssueForgeStatus = [];
    mockCalls.resolveIssueByChangeId = [];
    mockCalls.syncForgeCharterToIssue = [];
  });

  describe("POST /api/issues/:id/forge-link", () => {
    it("successfully links an existing issue to a Forge Charter (200)", async () => {
      const app = await createTestApp();

      const response = await request(app)
        .post("/api/issues/my-issue-id/forge-link")
        .send({ changeId: "change-123" })
        .set("Accept", "application/json");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        issueId: "my-issue-id",
        changeId: "change-123",
        linked: true,
      });

      // Verify service was called with correct arguments
      expect(mockCalls.linkIssueToForge).toHaveLength(1);
      expect(mockCalls.linkIssueToForge[0].input).toMatchObject({
        issueId: "my-issue-id",
        changeId: "change-123",
        companyId: "company-1",
      });
    });

    it("returns 409 FORGE_LINK_CONFLICT when change already linked to another issue", async () => {
      const app = await createTestApp();

      const response = await request(app)
        .post("/api/issues/my-issue-id/forge-link")
        .send({ changeId: "conflict-change" })
        .set("Accept", "application/json");

      expect(response.status).toBe(409);
      expect(response.body.code).toBe("FORGE_LINK_CONFLICT");
      expect(response.body.changeId).toBe("conflict-change");
    });

    it("returns 404 when issue not found", async () => {
      const app = await createTestApp();

      const response = await request(app)
        .post("/api/issues/non-existent/forge-link")
        .send({ changeId: "change-123" })
        .set("Accept", "application/json");

      expect(response.status).toBe(404);
    });

    it("returns 400 when changeId is missing", async () => {
      const app = await createTestApp();

      const response = await request(app)
        .post("/api/issues/my-issue-id/forge-link")
        .send({})
        .set("Accept", "application/json");

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("changeId");
    });

    it("returns 409 FORGE_LINK_CANCELLED_ISSUE when trying to link a cancelled issue", async () => {
      const app = await createTestApp();

      const response = await request(app)
        .post("/api/issues/cancelled-issue/forge-link")
        .send({ changeId: "change-123" })
        .set("Accept", "application/json");

      expect(response.status).toBe(409);
      expect(response.body.code).toBe("FORGE_LINK_CANCELLED_ISSUE");
    });
  });

  describe("GET /api/issues/:id/forge-link", () => {
    it("returns Forge link status with live Forge status for linked issue (200)", async () => {
      const app = await createTestApp();

      const response = await request(app)
        .get("/api/issues/linked-issue/forge-link")
        .set("Accept", "application/json");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        issueId: "linked-issue",
        changeId: "change-1",
        forgeStatus: "verified",
        linkActive: true,
      });
      expect(response.body.error).toBeUndefined();

      // Verify service was called
      expect(mockCalls.getLinkedIssueForgeStatus).toHaveLength(1);
      expect(mockCalls.getLinkedIssueForgeStatus[0].issueId).toBe("linked-issue");
    });

    it("returns link inactive for unlinked issue (200)", async () => {
      const app = await createTestApp();

      const response = await request(app)
        .get("/api/issues/unlinked-issue/forge-link")
        .set("Accept", "application/json");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        issueId: "unlinked-issue",
        linkActive: false,
        error: "Issue is not linked to a Forge Charter",
      });
    });

    it("returns 404 when issue not found", async () => {
      const app = await createTestApp();

      const response = await request(app)
        .get("/api/issues/non-existent/forge-link")
        .set("Accept", "application/json");

      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/companies/:companyId/forge/charters/:changeId/issue", () => {
    it("resolves linked issue by company and change_id (200)", async () => {
      const app = await createTestApp();

      const response = await request(app)
        .get("/api/companies/company-1/forge/charters/change-1/issue")
        .set("Accept", "application/json");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: "issue-123",
        originId: "change-1",
        originKind: "forge_charter",
        identifier: "PAP-123",
        title: "Linked Issue",
      });

      // Verify service was called
      expect(mockCalls.resolveIssueByChangeId).toHaveLength(1);
      expect(mockCalls.resolveIssueByChangeId[0].companyId).toBe("company-1");
      expect(mockCalls.resolveIssueByChangeId[0].changeId).toBe("change-1");
    });

    it("returns 404 when no linked issue exists", async () => {
      const app = await createTestApp();

      const response = await request(app)
        .get("/api/companies/company-1/forge/charters/unknown-change/issue")
        .set("Accept", "application/json");

      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/companies/:companyId/forge/charters/:changeId/sync-issue", () => {
    it("creates a new issue when none exists for the change_id (201)", async () => {
      const app = await createTestApp();

      const response = await request(app)
        .post("/api/companies/company-1/forge/charters/new-change/sync-issue")
        .send({ title: "Custom Title", description: "Test description" })
        .set("Accept", "application/json");

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        created: true,
        changeId: "new-change",
        issue: expect.objectContaining({
          originKind: "forge_charter",
          originId: "new-change",
          title: "Custom Title",
        }),
      });

      // Verify service was called with correct arguments
      expect(mockCalls.syncForgeCharterToIssue).toHaveLength(1);
      expect(mockCalls.syncForgeCharterToIssue[0].input).toMatchObject({
        companyId: "company-1",
        changeId: "new-change",
        title: "Custom Title",
        description: "Test description",
      });
    });

    it("returns existing issue when already linked (200 created=false)", async () => {
      const app = await createTestApp();

      const response = await request(app)
        .post("/api/companies/company-1/forge/charters/existing-change/sync-issue")
        .set("Accept", "application/json");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        created: false,
        changeId: "existing-change",
        issue: expect.objectContaining({
          id: "existing-issue",
          originId: "existing-change",
        }),
      });
    });
  });
});
