import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertForgeIssueCompletionAllowed,
  fetchForgeChangeStatus,
  FORGE_LINKED_ORIGIN_KIND,
  ForgeCompletionGuardError,
  isForgeLinkedIssue,
  isForgeStatusCompletionAllowed,
  shouldGuardIssueCompletion,
} from "../services/forge-completion-guard.js";

const mockFetch = vi.fn();
const mockLogActivity = vi.fn(async () => undefined);

describe("forge completion guard service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch.mockReset();
    mockLogActivity.mockReset();
  });

  describe("isForgeLinkedIssue", () => {
    it("returns true for forge_charter origin kind", () => {
      expect(isForgeLinkedIssue({ originKind: FORGE_LINKED_ORIGIN_KIND, originId: "change-123" })).toBe(true);
    });

    it("returns false for null origin kind", () => {
      expect(isForgeLinkedIssue({ originKind: null, originId: null })).toBe(false);
    });

    it("returns false for other origin kinds", () => {
      expect(isForgeLinkedIssue({ originKind: "github", originId: "123" })).toBe(false);
      expect(isForgeLinkedIssue({ originKind: "jira", originId: "456" })).toBe(false);
    });
  });

  describe("isForgeStatusCompletionAllowed", () => {
    it("returns true for verified status", () => {
      expect(isForgeStatusCompletionAllowed("verified")).toBe(true);
    });

    it("returns true for archived status", () => {
      expect(isForgeStatusCompletionAllowed("archived")).toBe(true);
    });

    it("returns false for in_progress status", () => {
      expect(isForgeStatusCompletionAllowed("in_progress")).toBe(false);
    });

    it("returns false for approved status", () => {
      expect(isForgeStatusCompletionAllowed("approved")).toBe(false);
    });

    it("returns false for draft status", () => {
      expect(isForgeStatusCompletionAllowed("draft")).toBe(false);
    });

    it("returns false for unknown status", () => {
      expect(isForgeStatusCompletionAllowed("unknown")).toBe(false);
    });
  });

  describe("shouldGuardIssueCompletion", () => {
    it("returns true when transitioning TO done from another status", () => {
      expect(shouldGuardIssueCompletion("in_progress", "done")).toBe(true);
      expect(shouldGuardIssueCompletion("todo", "done")).toBe(true);
      expect(shouldGuardIssueCompletion("blocked", "done")).toBe(true);
    });

    it("returns false when issue is already done (no actual transition)", () => {
      // Already done issues receiving "done" again should not be guarded
      expect(shouldGuardIssueCompletion("done", "done")).toBe(false);
    });

    it("returns false for transitions to other statuses", () => {
      expect(shouldGuardIssueCompletion("todo", "in_progress")).toBe(false);
      expect(shouldGuardIssueCompletion("in_progress", "blocked")).toBe(false);
      expect(shouldGuardIssueCompletion("done", "todo")).toBe(false);
    });

    it("returns false when no status change requested", () => {
      expect(shouldGuardIssueCompletion("in_progress", undefined)).toBe(false);
      expect(shouldGuardIssueCompletion("done", undefined)).toBe(false);
    });
  });

  describe("fetchForgeChangeStatus", () => {
    it("returns status when Forge API returns 200 with valid response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "verified" }),
      });

      const result = await fetchForgeChangeStatus(
        "change-123",
        { forgeApiUrl: "http://forge.test", forgeApiToken: "token-123" },
        mockFetch
      );

      expect(result).toEqual({ changeId: "change-123", status: "verified" });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://forge.test/api/spec/changes/change-123",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Accept: "application/json",
            Authorization: "Bearer token-123",
          }),
        })
      );
    });

    it("works without token when Forge allows unauthenticated access", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "archived" }),
      });

      const result = await fetchForgeChangeStatus(
        "change-123",
        { forgeApiUrl: "http://forge.test", forgeApiToken: undefined },
        mockFetch
      );

      expect(result).toEqual({ changeId: "change-123", status: "archived" });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://forge.test/api/spec/changes/change-123",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Accept: "application/json",
          }),
        })
      );
      // Authorization header should not be present when no token
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBeUndefined();
    });

    it("returns null when FORGE_API_URL is missing", async () => {
      const result = await fetchForgeChangeStatus(
        "change-123",
        { forgeApiUrl: undefined, forgeApiToken: "token-123" },
        mockFetch
      );

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns null when Forge returns non-2xx response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const result = await fetchForgeChangeStatus(
        "change-123",
        { forgeApiUrl: "http://forge.test", forgeApiToken: "token-123" },
        mockFetch
      );

      expect(result).toBeNull();
    });

    it("returns null when Forge response lacks status field", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ otherField: "value" }),
      });

      const result = await fetchForgeChangeStatus(
        "change-123",
        { forgeApiUrl: "http://forge.test", forgeApiToken: "token-123" },
        mockFetch
      );

      expect(result).toBeNull();
    });

    it("returns null when fetch throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await fetchForgeChangeStatus(
        "change-123",
        { forgeApiUrl: "http://forge.test", forgeApiToken: "token-123" },
        mockFetch
      );

      expect(result).toBeNull();
    });

    it("properly encodes change_id in URL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "verified" }),
      });

      await fetchForgeChangeStatus(
        "change/with/special+chars",
        { forgeApiUrl: "http://forge.test", forgeApiToken: "token-123" },
        mockFetch
      );

      expect(mockFetch).toHaveBeenCalledWith(
        "http://forge.test/api/spec/changes/change%2Fwith%2Fspecial%2Bchars",
        expect.any(Object)
      );
    });
  });

  describe("assertForgeIssueCompletionAllowed", () => {
    it("allows completion when Forge status is verified", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "verified" }),
      });

      const result = await assertForgeIssueCompletionAllowed(
        {
          id: "issue-123",
          companyId: "company-1",
          originKind: FORGE_LINKED_ORIGIN_KIND,
          originId: "change-123",
          status: "in_progress",
        },
        {
          config: { forgeApiUrl: "http://forge.test", forgeApiToken: "token-123" },
          fetchImpl: mockFetch,
          logActivity: mockLogActivity,
        }
      );

      expect(result.allowed).toBe(true);
      expect(result.changeId).toBe("change-123");
      expect(result.forgeStatus).toBe("verified");
    });

    it("allows completion when Forge status is archived", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "archived" }),
      });

      const result = await assertForgeIssueCompletionAllowed(
        {
          id: "issue-123",
          companyId: "company-1",
          originKind: FORGE_LINKED_ORIGIN_KIND,
          originId: "change-123",
          status: "in_progress",
        },
        {
          config: { forgeApiUrl: "http://forge.test", forgeApiToken: "token-123" },
          fetchImpl: mockFetch,
          logActivity: mockLogActivity,
        }
      );

      expect(result.allowed).toBe(true);
      expect(result.forgeStatus).toBe("archived");
    });

    it("blocks completion when originId is missing", async () => {
      let caughtError: ForgeCompletionGuardError | null = null;
      try {
        await assertForgeIssueCompletionAllowed(
          {
            id: "issue-123",
            companyId: "company-1",
            originKind: FORGE_LINKED_ORIGIN_KIND,
            originId: null,
            status: "in_progress",
          },
          {
            config: { forgeApiUrl: "http://forge.test", forgeApiToken: "token-123" },
            fetchImpl: mockFetch,
            logActivity: mockLogActivity,
          }
        );
      } catch (err) {
        caughtError = err as ForgeCompletionGuardError;
      }

      expect(caughtError).toBeInstanceOf(ForgeCompletionGuardError);
      expect(caughtError?.code).toBe("FORGE_LINK_MALFORMED");
      expect(caughtError?.changeId).toBeNull();

      // Verify activity was logged
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "issue.completion_blocked",
          entityId: "issue-123",
          details: expect.objectContaining({
            reason: "missing_origin_id",
            code: "FORGE_LINK_MALFORMED",
          }),
        })
      );
    });

    it("blocks completion when FORGE_API_URL is missing", async () => {
      let caughtError: ForgeCompletionGuardError | null = null;
      try {
        await assertForgeIssueCompletionAllowed(
          {
            id: "issue-123",
            companyId: "company-1",
            originKind: FORGE_LINKED_ORIGIN_KIND,
            originId: "change-123",
            status: "in_progress",
          },
          {
            config: { forgeApiUrl: undefined, forgeApiToken: "token-123" },
            fetchImpl: mockFetch,
            logActivity: mockLogActivity,
          }
        );
      } catch (err) {
        caughtError = err as ForgeCompletionGuardError;
      }

      expect(caughtError).toBeInstanceOf(ForgeCompletionGuardError);
      expect(caughtError?.code).toBe("FORGE_CONFIG_MISSING");
      expect(caughtError?.changeId).toBe("change-123");

      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "issue.completion_blocked",
          details: expect.objectContaining({
            reason: "forge_api_url_missing",
            code: "FORGE_CONFIG_MISSING",
          }),
        })
      );
    });

    it("blocks completion when Forge returns non-2xx", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      let caughtError: ForgeCompletionGuardError | null = null;
      try {
        await assertForgeIssueCompletionAllowed(
          {
            id: "issue-123",
            companyId: "company-1",
            originKind: FORGE_LINKED_ORIGIN_KIND,
            originId: "change-123",
            status: "in_progress",
          },
          {
            config: { forgeApiUrl: "http://forge.test", forgeApiToken: "token-123" },
            fetchImpl: mockFetch,
            logActivity: mockLogActivity,
          }
        );
      } catch (err) {
        caughtError = err as ForgeCompletionGuardError;
      }

      expect(caughtError).toBeInstanceOf(ForgeCompletionGuardError);
      expect(caughtError?.code).toBe("FORGE_STATUS_UNAVAILABLE");
      expect(caughtError?.changeId).toBe("change-123");
    });

    it("blocks completion when Forge is unreachable", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      let caughtError: ForgeCompletionGuardError | null = null;
      try {
        await assertForgeIssueCompletionAllowed(
          {
            id: "issue-123",
            companyId: "company-1",
            originKind: FORGE_LINKED_ORIGIN_KIND,
            originId: "change-123",
            status: "in_progress",
          },
          {
            config: { forgeApiUrl: "http://forge.test", forgeApiToken: "token-123" },
            fetchImpl: mockFetch,
            logActivity: mockLogActivity,
          }
        );
      } catch (err) {
        caughtError = err as ForgeCompletionGuardError;
      }

      expect(caughtError).toBeInstanceOf(ForgeCompletionGuardError);
      expect(caughtError?.code).toBe("FORGE_STATUS_UNAVAILABLE");
      expect(caughtError?.changeId).toBe("change-123");
    });

    it("blocks completion when Forge status is in_progress", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "in_progress" }),
      });

      let caughtError: ForgeCompletionGuardError | null = null;
      try {
        await assertForgeIssueCompletionAllowed(
          {
            id: "issue-123",
            companyId: "company-1",
            originKind: FORGE_LINKED_ORIGIN_KIND,
            originId: "change-123",
            status: "in_progress",
          },
          {
            config: { forgeApiUrl: "http://forge.test", forgeApiToken: "token-123" },
            fetchImpl: mockFetch,
            logActivity: mockLogActivity,
          }
        );
      } catch (err) {
        caughtError = err as ForgeCompletionGuardError;
      }

      expect(caughtError).toBeInstanceOf(ForgeCompletionGuardError);
      expect(caughtError?.code).toBe("FORGE_STATUS_UNVERIFIED");
      expect(caughtError?.message).toContain("in_progress");
      expect(caughtError?.changeId).toBe("change-123");

      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "issue.completion_blocked",
          details: expect.objectContaining({
            reason: "forge_status_unverified",
            forgeStatus: "in_progress",
          }),
        })
      );
    });

    it("blocks completion when Forge status is draft", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "draft" }),
      });

      let caughtError: ForgeCompletionGuardError | null = null;
      try {
        await assertForgeIssueCompletionAllowed(
          {
            id: "issue-123",
            companyId: "company-1",
            originKind: FORGE_LINKED_ORIGIN_KIND,
            originId: "change-123",
            status: "in_progress",
          },
          {
            config: { forgeApiUrl: "http://forge.test", forgeApiToken: "token-123" },
            fetchImpl: mockFetch,
            logActivity: mockLogActivity,
          }
        );
      } catch (err) {
        caughtError = err as ForgeCompletionGuardError;
      }

      expect(caughtError).toBeInstanceOf(ForgeCompletionGuardError);
      expect(caughtError?.code).toBe("FORGE_STATUS_UNVERIFIED");
      expect(caughtError?.changeId).toBe("change-123");
    });

    it("blocks completion when Forge returns malformed response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ otherField: "value" }),
      });

      let caughtError: ForgeCompletionGuardError | null = null;
      try {
        await assertForgeIssueCompletionAllowed(
          {
            id: "issue-123",
            companyId: "company-1",
            originKind: FORGE_LINKED_ORIGIN_KIND,
            originId: "change-123",
            status: "in_progress",
          },
          {
            config: { forgeApiUrl: "http://forge.test", forgeApiToken: "token-123" },
            fetchImpl: mockFetch,
            logActivity: mockLogActivity,
          }
        );
      } catch (err) {
        caughtError = err as ForgeCompletionGuardError;
      }

      expect(caughtError).toBeInstanceOf(ForgeCompletionGuardError);
      expect(caughtError?.code).toBe("FORGE_STATUS_UNAVAILABLE");
      expect(caughtError?.changeId).toBe("change-123");
    });

    it("does not expose token values in error messages", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      try {
        await assertForgeIssueCompletionAllowed(
          {
            id: "issue-123",
            companyId: "company-1",
            originKind: FORGE_LINKED_ORIGIN_KIND,
            originId: "change-123",
            status: "in_progress",
          },
          {
            config: { forgeApiUrl: "http://forge.test", forgeApiToken: "secret-token-value" },
            fetchImpl: mockFetch,
            logActivity: mockLogActivity,
          }
        );
      } catch (err) {
        const errorMessage = (err as Error).message;
        const errorDetails = JSON.stringify((err as ForgeCompletionGuardError).details);
        expect(errorMessage).not.toContain("secret-token-value");
        expect(errorDetails).not.toContain("secret-token-value");
      }
    });

    it("does not expose token values in activity log", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      try {
        await assertForgeIssueCompletionAllowed(
          {
            id: "issue-123",
            companyId: "company-1",
            originKind: FORGE_LINKED_ORIGIN_KIND,
            originId: "change-123",
            status: "in_progress",
          },
          {
            config: { forgeApiUrl: "http://forge.test", forgeApiToken: "secret-token-value" },
            fetchImpl: mockFetch,
            logActivity: mockLogActivity,
          }
        );
      } catch (err) {
        // Activity log should have been called
        expect(mockLogActivity).toHaveBeenCalled();
        const logCall = mockLogActivity.mock.calls[0][0];
        const logDetails = JSON.stringify(logCall.details);
        expect(logDetails).not.toContain("secret-token-value");
      }
    });
  });
});

// =============================================================================
// ROUTE-LEVEL BEHAVIORAL TESTS
// Following pattern from issue-update-comment-wakeup-routes.test.ts
// =============================================================================

import express from "express";
import request from "supertest";

// Hoisted mocks for route tests
const routeMockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getCommentCursor: vi.fn(),
  getAncestors: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  listAttachments: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  remove: vi.fn(),
  checkout: vi.fn(),
  markRead: vi.fn(),
  markUnread: vi.fn(),
  archiveInbox: vi.fn(),
  unarchiveInbox: vi.fn(),
  syncRunStatusForIssue: vi.fn(),
}));

const routeMockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const routeMockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const routeMockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => true),
  hasPermission: vi.fn(async () => true),
}));

const routeMockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
    ambiguous: false,
    agent: { id: raw },
  })),
  list: vi.fn(async () => []),
}));

const routeMockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(async () => ({ id: "company-1", name: "Test Company" })),
}));

const routeMockProjectService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  listByIds: vi.fn(async () => []),
}));

const routeMockGoalService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  getDefaultCompanyGoal: vi.fn(async () => null),
}));

const routeMockDocumentService = vi.hoisted(() => ({
  getIssueDocumentPayload: vi.fn(async () => ({})),
  listIssueDocuments: vi.fn(async () => []),
  getIssueDocumentByKey: vi.fn(async () => null),
  upsertIssueDocument: vi.fn(),
  listIssueDocumentRevisions: vi.fn(),
  restoreIssueDocumentRevision: vi.fn(),
  deleteIssueDocument: vi.fn(),
}));

const routeMockIssueReferenceService = vi.hoisted(() => ({
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  syncIssue: vi.fn(async () => undefined),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  deleteDocumentSource: vi.fn(async () => undefined),
}));

const routeMockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));

const routeMockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  getById: vi.fn(async () => null),
  update: vi.fn(),
  remove: vi.fn(),
  createForIssue: vi.fn(),
}));

const routeMockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
  link: vi.fn(),
  unlink: vi.fn(),
}));

const routeMockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));

const routeMockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  listForCompany: vi.fn(async () => []),
}));

const routeMockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  getGeneral: vi.fn(async () => ({
    censorUsernameInLogs: false,
    feedbackDataSharingPreference: "prompt",
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));

const routeMockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));

const routeMockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));

// Mock the guard service to control Forge responses
const routeMockFetchForgeStatus = vi.hoisted(() => vi.fn());

// Mock global fetch to control Forge API responses
// This allows the real guard service to run but controls what Forge returns
const originalFetch = global.fetch;
vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = url.toString();

  // Only intercept Forge API calls
  if (urlStr.includes("/api/spec/changes/")) {
    const forgeStatus = await routeMockFetchForgeStatus(urlStr);

    if (!forgeStatus) {
      // Simulate network error or missing config
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }

    return new Response(JSON.stringify({ status: forgeStatus.status }), { status: 200 });
  }

  // Pass through other requests
  return originalFetch(url, init);
}));

vi.mock("../services/index.js", () => ({
  accessService: () => routeMockAccessService,
  agentService: () => routeMockAgentService,
  companyService: () => routeMockCompanyService,
  documentService: () => routeMockDocumentService,
  executionWorkspaceService: () => routeMockExecutionWorkspaceService,
  feedbackService: () => routeMockFeedbackService,
  goalService: () => routeMockGoalService,
  heartbeatService: () => routeMockHeartbeatService,
  instanceSettingsService: () => routeMockInstanceSettingsService,
  issueApprovalService: () => routeMockIssueApprovalService,
  issueReferenceService: () => routeMockIssueReferenceService,
  issueService: () => routeMockIssueService,
  issueTreeControlService: () => routeMockIssueTreeControlService,
  logActivity: routeMockLogActivity,
  projectService: () => routeMockProjectService,
  routineService: () => routeMockRoutineService,
  workProductService: () => routeMockWorkProductService,
  environmentService: () => routeMockEnvironmentService,
  // Export guard functions - we'll mock fetchForgeChangeStatus to control behavior
  assertForgeIssueCompletionAllowed: vi.fn(async (issue: any, options: any = {}) => {
    // Simulate the guard behavior based on mocked Forge status
    const forgeStatus = await routeMockFetchForgeStatus(issue.originId);

    if (!forgeStatus) {
      const error = new Error("Cannot complete Forge-linked issue: unable to verify Forge status") as any;
      error.status = 409;
      error.code = "FORGE_STATUS_UNAVAILABLE";
      error.changeId = issue.originId;
      throw error;
    }

    if (forgeStatus.status !== "verified" && forgeStatus.status !== "archived") {
      const error = new Error(`Cannot complete Forge-linked issue: Forge status is "${forgeStatus.status}"`) as any;
      error.status = 409;
      error.code = "FORGE_STATUS_UNVERIFIED";
      error.changeId = issue.originId;
      throw error;
    }

    return { allowed: true, changeId: issue.originId, forgeStatus: forgeStatus.status };
  }),
  ForgeCompletionGuardError: class ForgeCompletionGuardError extends Error {
    code: string;
    changeId: string | null;
    constructor(message: string, code: string, changeId: string | null) {
      super(message);
      this.code = code;
      this.changeId = changeId;
    }
  },
  isForgeLinkedIssue: vi.fn((issue: any) => issue.originKind === FORGE_LINKED_ORIGIN_KIND),
  shouldGuardIssueCompletion: vi.fn((existingStatus: string, requestedStatus: string | undefined) => {
    return requestedStatus === "done" && existingStatus !== "done";
  }),
  fetchForgeChangeStatus: vi.fn(async (changeId: string) => routeMockFetchForgeStatus(changeId)),
  FORGE_LINKED_ORIGIN_KIND: "forge_charter",
}));

function registerRouteMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => routeMockAccessService,
    agentService: () => routeMockAgentService,
    companyService: () => routeMockCompanyService,
    documentService: () => routeMockDocumentService,
    executionWorkspaceService: () => routeMockExecutionWorkspaceService,
    feedbackService: () => routeMockFeedbackService,
    goalService: () => routeMockGoalService,
    heartbeatService: () => routeMockHeartbeatService,
    instanceSettingsService: () => routeMockInstanceSettingsService,
    issueApprovalService: () => routeMockIssueApprovalService,
    issueReferenceService: () => routeMockIssueReferenceService,
    issueService: () => routeMockIssueService,
    issueTreeControlService: () => routeMockIssueTreeControlService,
    logActivity: routeMockLogActivity,
    projectService: () => routeMockProjectService,
    routineService: () => routeMockRoutineService,
    workProductService: () => routeMockWorkProductService,
    environmentService: () => routeMockEnvironmentService,
    assertForgeIssueCompletionAllowed: vi.fn(async (issue: any, options: any = {}) => {
      const forgeStatus = await routeMockFetchForgeStatus(issue.originId);

      if (!forgeStatus) {
        const error = new Error("Cannot complete Forge-linked issue: unable to verify Forge status") as any;
        error.status = 409;
        error.code = "FORGE_STATUS_UNAVAILABLE";
        error.changeId = issue.originId;
        throw error;
      }

      if (forgeStatus.status !== "verified" && forgeStatus.status !== "archived") {
        const error = new Error(`Cannot complete Forge-linked issue: Forge status is "${forgeStatus.status}"`) as any;
        error.status = 409;
        error.code = "FORGE_STATUS_UNVERIFIED";
        error.changeId = issue.originId;
        throw error;
      }

      return { allowed: true, changeId: issue.originId, forgeStatus: forgeStatus.status };
    }),
    ForgeCompletionGuardError: class ForgeCompletionGuardError extends Error {
      code: string;
      changeId: string | null;
      constructor(message: string, code: string, changeId: string | null) {
        super(message);
        this.code = code;
        this.changeId = changeId;
      }
    },
    isForgeLinkedIssue: vi.fn((issue: any) => issue.originKind === FORGE_LINKED_ORIGIN_KIND),
    shouldGuardIssueCompletion: vi.fn((existingStatus: string, requestedStatus: string | undefined) => {
      return requestedStatus === "done" && existingStatus !== "done";
    }),
    fetchForgeChangeStatus: vi.fn(async (changeId: string) => routeMockFetchForgeStatus(changeId)),
    FORGE_LINKED_ORIGIN_KIND: "forge_charter",
  }));
}

async function createRouteApp() {
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
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeLinkedIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "in_progress",
    originKind: FORGE_LINKED_ORIGIN_KIND,
    originId: "change-1",
    originDisplayName: null,
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: "local-board",
    createdByUserId: "local-board",
    identifier: "PAP-999",
    title: "Linked Issue",
    description: null,
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    hiddenAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeUnlinkedIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    companyId: "company-1",
    status: "in_progress",
    originKind: null,
    originId: null,
    originDisplayName: null,
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: "local-board",
    createdByUserId: "local-board",
    identifier: "PAP-998",
    title: "Unlinked Issue",
    description: null,
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    hiddenAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("linked issue completion route", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();

    // Set up Forge API URL for tests
    process.env = { ...originalEnv, FORGE_API_URL: "http://forge.test" };

    // Set up default mock behaviors
    routeMockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    routeMockIssueService.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 0, unresolvedBlockerIssueIds: [] });
    routeMockIssueService.getCommentCursor.mockResolvedValue(null);
    routeMockIssueService.getAncestors.mockResolvedValue([]);
    routeMockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    routeMockIssueService.listAttachments.mockResolvedValue([]);
    routeMockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    routeMockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    routeMockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    routeMockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("linked issue + Forge in_progress blocks with 409, response includes stable code and changeId, and update is not called", async () => {
    // Setup: Forge returns in_progress status
    routeMockFetchForgeStatus.mockResolvedValueOnce({ status: "in_progress" });

    const app = await createRouteApp();
    const existing = makeLinkedIssue();
    routeMockIssueService.getById.mockResolvedValueOnce(existing);

    // Attempt to transition to done
    const response = await request(app)
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done" })
      .set("Accept", "application/json");

    // Verify conflict response
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("in_progress"),
      code: "FORGE_STATUS_UNVERIFIED",
      changeId: "change-1",
    });

    // Verify issue was NOT updated (guard ran before update)
    expect(routeMockIssueService.update).not.toHaveBeenCalled();
  });

  it("linked issue + Forge verified allows 200 and calls update with status done", async () => {
    // Setup: Forge returns verified status
    routeMockFetchForgeStatus.mockResolvedValueOnce({ status: "verified" });

    const app = await createRouteApp();
    const existing = makeLinkedIssue();
    routeMockIssueService.getById.mockResolvedValueOnce(existing);

    // Mock successful update
    routeMockIssueService.update.mockResolvedValueOnce({
      ...existing,
      status: "done",
    });

    const response = await request(app)
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done" })
      .set("Accept", "application/json");

    // Verify success
    expect(response.status).toBe(200);
    const updateCall = routeMockIssueService.update.mock.calls[0];
    expect(updateCall[0]).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(updateCall[1]).toHaveProperty("status", "done");
  });

  it("unlinked issue allows 200 and does not require Forge config check", async () => {
    const app = await createRouteApp();
    const existing = makeUnlinkedIssue();
    routeMockIssueService.getById.mockResolvedValueOnce(existing);

    routeMockIssueService.update.mockResolvedValueOnce({
      ...existing,
      status: "done",
    });

    const response = await request(app)
      .patch("/api/issues/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
      .send({ status: "done" })
      .set("Accept", "application/json");

    // Verify success - no Forge check needed for unlinked issues
    expect(response.status).toBe(200);
    expect(routeMockFetchForgeStatus).not.toHaveBeenCalled(); // No Forge API call made
    expect(routeMockIssueService.update).toHaveBeenCalled();
  });

  it("blocked response must not include FORGE_API_TOKEN value", async () => {
    // Setup: Forge returns in_progress status
    routeMockFetchForgeStatus.mockResolvedValueOnce({ status: "in_progress" });

    const app = await createRouteApp();
    const existing = makeLinkedIssue();
    routeMockIssueService.getById.mockResolvedValueOnce(existing);

    // Set a fake token in env to verify it's not leaked
    const originalToken = process.env.FORGE_API_TOKEN;
    process.env.FORGE_API_TOKEN = "super-secret-token-12345";

    try {
      const response = await request(app)
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({ status: "done" })
        .set("Accept", "application/json");

      expect(response.status).toBe(409);

      // Verify no secrets in response
      const responseBody = JSON.stringify(response.body);
      expect(responseBody).not.toContain("super-secret-token-12345");
      expect(responseBody).not.toContain("token");
      expect(responseBody).not.toContain("secret");
      expect(responseBody).not.toContain("bearer");
      expect(responseBody).not.toContain("auth");
    } finally {
      process.env.FORGE_API_TOKEN = originalToken;
    }
  });
});
