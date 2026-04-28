import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// =============================================================================
// SERVICE MOCKS - Following established codebase pattern
// =============================================================================

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  update: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockLinkIssueToForge = vi.hoisted(() => vi.fn());
const mockGetLinkedIssueForgeStatus = vi.hoisted(() => vi.fn());
const mockResolveIssueByChangeId = vi.hoisted(() => vi.fn());
const mockSyncForgeCharterToIssue = vi.hoisted(() => vi.fn());
const mockFetchForgeStatus = vi.hoisted(() => vi.fn());
const mockFindLinkedIssueByChangeId = vi.hoisted(() => vi.fn());
const mockUnlinkIssueFromForge = vi.hoisted(() => vi.fn());

const mockAssertForgeIssueCompletionAllowed = vi.hoisted(() => vi.fn());
const mockIsForgeLinkedIssue = vi.hoisted(() => vi.fn());
const mockShouldGuardIssueCompletion = vi.hoisted(() => vi.fn());

// Mock the services index to provide issueService factory
vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>("../services/index.js");
  return {
    ...actual,
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
  };
});

// Mock forge-sync module
vi.mock("../services/forge-sync.js", async () => {
  const actual = await vi.importActual<typeof import("../services/forge-sync.js")>("../services/forge-sync.js");
  return {
    ...actual,
    linkIssueToForge: mockLinkIssueToForge,
    getLinkedIssueForgeStatus: mockGetLinkedIssueForgeStatus,
    resolveIssueByChangeId: mockResolveIssueByChangeId,
    syncForgeCharterToIssue: mockSyncForgeCharterToIssue,
    fetchForgeStatus: mockFetchForgeStatus,
    findLinkedIssueByChangeId: mockFindLinkedIssueByChangeId,
    unlinkIssueFromForge: mockUnlinkIssueFromForge,
  };
});

// Mock forge-completion-guard module
vi.mock("../services/forge-completion-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../services/forge-completion-guard.js")>("../services/forge-completion-guard.js");
  return {
    ...actual,
    assertForgeIssueCompletionAllowed: mockAssertForgeIssueCompletionAllowed,
    isForgeLinkedIssue: mockIsForgeLinkedIssue,
    shouldGuardIssueCompletion: mockShouldGuardIssueCompletion,
  };
});

// Create test app
async function createTestApp() {
  vi.resetModules();
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/issues.js") as Promise<typeof import("../routes/issues.js")>,
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

  const mockDb = {} as any;
  const mockStorage = {} as any;

  app.use("/api", issueRoutes(mockDb, mockStorage));
  app.use(errorHandler);
  return app;
}

// =============================================================================
// FORGE SYNC SERVICE TESTS
// =============================================================================

describe("forge sync service", () => {
  it("exports all required functions for route handlers", async () => {
    const forgeSync = await vi.importActual<typeof import("../services/forge-sync.js")>("../services/forge-sync.js");

    expect(typeof forgeSync.fetchForgeStatus).toBe("function");
    expect(typeof forgeSync.findLinkedIssueByChangeId).toBe("function");
    expect(typeof forgeSync.linkIssueToForge).toBe("function");
    expect(typeof forgeSync.getLinkedIssueForgeStatus).toBe("function");
    expect(typeof forgeSync.resolveIssueByChangeId).toBe("function");
    expect(typeof forgeSync.syncForgeCharterToIssue).toBe("function");
    expect(typeof forgeSync.unlinkIssueFromForge).toBe("function");
    expect(typeof forgeSync.ForgeSyncError).toBe("function");
  });

  it("ForgeSyncError has correct structure", async () => {
    const forgeSync = await vi.importActual<typeof import("../services/forge-sync.js")>("../services/forge-sync.js");
    const error = new forgeSync.ForgeSyncError(
      "Test message",
      "TEST_CODE",
      "change-123",
      409
    );

    expect(error.message).toBe("Test message");
    expect(error.code).toBe("TEST_CODE");
    expect(error.changeId).toBe("change-123");
    expect((error as any).status).toBe(409);
    expect(error).toBeInstanceOf(Error);
  });

  describe("HTTP-only fetch behavior (REQ-005, REQ-007)", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("fetchForgeChangeStatus calls correct HTTP endpoint URL", async () => {
      const { fetchForgeChangeStatus } = await vi.importActual<typeof import("../services/forge-completion-guard.js")>("../services/forge-completion-guard.js");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "verified" }),
      } as Response);

      const config = {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret-token-123",
      };

      await fetchForgeChangeStatus("change-abc", config, mockFetch as any);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://forge.test/api/spec/changes/change-abc",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Accept: "application/json",
          }),
        })
      );
    });

    it("fetchForgeChangeStatus sends Authorization header with token", async () => {
      const { fetchForgeChangeStatus } = await vi.importActual<typeof import("../services/forge-completion-guard.js")>("../services/forge-completion-guard.js");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "verified" }),
      } as Response);

      const config = {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret-token-123",
      };

      await fetchForgeChangeStatus("change-abc", config, mockFetch as any);

      const callArgs = mockFetch.mock.calls[0];
      const headers = callArgs[1].headers;
      expect(headers.Authorization).toBe("Bearer secret-token-123");
    });

    it("fetchForgeChangeStatus fails closed with null on non-2xx response", async () => {
      const { fetchForgeChangeStatus } = await vi.importActual<typeof import("../services/forge-completion-guard.js")>("../services/forge-completion-guard.js");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      } as Response);

      const config = {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret-token",
      };

      const result = await fetchForgeChangeStatus("change-abc", config, mockFetch as any);

      expect(result).toBeNull();
    });

    it("fetchForgeChangeStatus fails closed with null on malformed JSON response", async () => {
      const { fetchForgeChangeStatus } = await vi.importActual<typeof import("../services/forge-completion-guard.js")>("../services/forge-completion-guard.js");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ missingStatusField: true }),
      } as Response);

      const config = {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret-token",
      };

      const result = await fetchForgeChangeStatus("change-abc", config, mockFetch as any);

      expect(result).toBeNull();
    });

    it("fetchForgeChangeStatus fails closed with null on network error", async () => {
      const { fetchForgeChangeStatus } = await vi.importActual<typeof import("../services/forge-completion-guard.js")>("../services/forge-completion-guard.js");

      const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const config = {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret-token",
      };

      const result = await fetchForgeChangeStatus("change-abc", config, mockFetch as any);

      expect(result).toBeNull();
    });

    it("fetchForgeChangeStatus fails closed with null when FORGE_API_URL missing", async () => {
      const { fetchForgeChangeStatus } = await vi.importActual<typeof import("../services/forge-completion-guard.js")>("../services/forge-completion-guard.js");

      const mockFetch = vi.fn();

      const config = {
        forgeApiUrl: undefined,
        forgeApiToken: "secret-token",
      };

      const result = await fetchForgeChangeStatus("change-abc", config, mockFetch as any);

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("error messages do not expose FORGE_API_TOKEN value", async () => {
      const { fetchForgeChangeStatus } = await vi.importActual<typeof import("../services/forge-completion-guard.js")>("../services/forge-completion-guard.js");

      const secretToken = "super-secret-token-xyz-123";

      // Test with various error scenarios
      const scenarios = [
        { ok: false, status: 401, statusText: "Unauthorized" },
        { ok: false, status: 403, statusText: "Forbidden" },
        { ok: false, status: 500, statusText: "Server Error" },
      ];

      for (const scenario of scenarios) {
        const mockFetch = vi.fn().mockResolvedValue({
          ...scenario,
          json: async () => ({ error: "Some error" }),
        } as Response);

        const config = {
          forgeApiUrl: "http://forge.test",
          forgeApiToken: secretToken,
        };

        // Should not throw, just return null
        const result = await fetchForgeChangeStatus("change-abc", config, mockFetch as any);
        expect(result).toBeNull();

        // Verify token is not in any error path (function returns null, doesn't throw)
        // The real test is that the function doesn't leak the token in logs or errors
      }

      // Additional test: verify token is not in returned data
      const mockFetchSuccess = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "verified" }),
      } as Response);

      const config = {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: secretToken,
      };

      const result = await fetchForgeChangeStatus("change-abc", config, mockFetchSuccess as any);
      expect(result).toEqual({ changeId: "change-abc", status: "verified" });

      // Verify the result doesn't contain the token
      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain(secretToken);
    });
  });
});

// =============================================================================
// ROUTE-LEVEL BEHAVIORAL TESTS
// =============================================================================

describe("forge sync routes", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, FORGE_API_URL: "http://forge.test" };

    // Default mock behaviors
    mockShouldGuardIssueCompletion.mockReturnValue(false);
    mockIsForgeLinkedIssue.mockReturnValue(false);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("POST /api/issues/:id/forge-link", () => {
    it("successfully links an existing issue to a Forge Charter (200)", async () => {
      const app = await createTestApp();

      // Mock the issue exists
      mockIssueService.getById.mockResolvedValueOnce({
        id: "issue-123",
        companyId: "company-1",
        status: "backlog",
        originKind: null,
        originId: null,
      });

      mockLinkIssueToForge.mockResolvedValueOnce({
        issueId: "issue-123",
        changeId: "change-123",
        linked: true,
        previousChangeId: null,
      });

      const response = await request(app)
        .post("/api/issues/issue-123/forge-link")
        .send({ changeId: "change-123" })
        .set("Accept", "application/json");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        issueId: "issue-123",
        changeId: "change-123",
        linked: true,
      });
      expect(mockLinkIssueToForge).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          issueId: "issue-123",
          changeId: "change-123",
          companyId: "company-1",
        })
      );
    });

    it("returns 409 FORGE_LINK_CONFLICT when change already linked to another issue", async () => {
      const app = await createTestApp();

      mockIssueService.getById.mockResolvedValueOnce({
        id: "issue-123",
        companyId: "company-1",
        status: "backlog",
        originKind: null,
        originId: null,
      });

      const { ForgeSyncError } = await import("../services/forge-sync.js");
      const conflictError = new ForgeSyncError(
        "Change change-123 is already linked to issue PAP-777",
        "FORGE_LINK_CONFLICT",
        "change-123",
        409
      );
      mockLinkIssueToForge.mockRejectedValueOnce(conflictError);

      const response = await request(app)
        .post("/api/issues/issue-123/forge-link")
        .send({ changeId: "change-123" })
        .set("Accept", "application/json");

      expect(response.status).toBe(409);
      expect(response.body.code).toBe("FORGE_LINK_CONFLICT");
      expect(response.body.changeId).toBe("change-123");
    });

    it("returns 404 when issue not found", async () => {
      const app = await createTestApp();

      mockIssueService.getById.mockResolvedValueOnce(null);

      const response = await request(app)
        .post("/api/issues/non-existent-issue/forge-link")
        .send({ changeId: "change-123" })
        .set("Accept", "application/json");

      expect(response.status).toBe(404);
    });

    it("returns 400 when changeId is missing", async () => {
      const app = await createTestApp();

      mockIssueService.getById.mockResolvedValueOnce({
        id: "issue-123",
        companyId: "company-1",
        status: "backlog",
      });

      const response = await request(app)
        .post("/api/issues/issue-123/forge-link")
        .send({})
        .set("Accept", "application/json");

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("changeId");
    });

    it("returns 409 FORGE_LINK_CANCELLED_ISSUE when trying to link a cancelled issue", async () => {
      const app = await createTestApp();

      mockIssueService.getById.mockResolvedValueOnce({
        id: "cancelled-issue",
        companyId: "company-1",
        status: "cancelled",
        originKind: null,
        originId: null,
      });

      const { ForgeSyncError } = await import("../services/forge-sync.js");
      const cancelledError = new ForgeSyncError(
        "Cannot link cancelled issue to Forge Charter",
        "FORGE_LINK_CANCELLED_ISSUE",
        "change-123",
        409
      );
      mockLinkIssueToForge.mockRejectedValueOnce(cancelledError);

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

      mockIssueService.getById.mockResolvedValueOnce({
        id: "linked-issue",
        companyId: "company-1",
        status: "in_progress",
        originKind: "forge_charter",
        originId: "change-1",
      });

      mockGetLinkedIssueForgeStatus.mockResolvedValueOnce({
        issueId: "linked-issue",
        changeId: "change-1",
        forgeStatus: "verified",
        linkActive: true,
      });

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
    });

    it("returns link inactive for unlinked issue (200)", async () => {
      const app = await createTestApp();

      mockIssueService.getById.mockResolvedValueOnce({
        id: "unlinked-issue",
        companyId: "company-1",
        status: "backlog",
        originKind: null,
        originId: null,
      });

      mockGetLinkedIssueForgeStatus.mockResolvedValueOnce({
        issueId: "unlinked-issue",
        changeId: "",
        forgeStatus: null,
        linkActive: false,
        error: "Issue is not linked to a Forge Charter",
      });

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

      mockIssueService.getById.mockResolvedValueOnce(null);

      const response = await request(app)
        .get("/api/issues/non-existent/forge-link")
        .set("Accept", "application/json");

      expect(response.status).toBe(404);
    });

    it("returns error in body when Forge status fetch fails (200)", async () => {
      const app = await createTestApp();

      mockIssueService.getById.mockResolvedValueOnce({
        id: "linked-issue",
        companyId: "company-1",
        status: "in_progress",
        originKind: "forge_charter",
        originId: "change-1",
      });

      mockGetLinkedIssueForgeStatus.mockResolvedValueOnce({
        issueId: "linked-issue",
        changeId: "change-1",
        forgeStatus: null,
        linkActive: true,
        error: "Failed to fetch Forge status",
      });

      const response = await request(app)
        .get("/api/issues/linked-issue/forge-link")
        .set("Accept", "application/json");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        issueId: "linked-issue",
        changeId: "change-1",
        forgeStatus: null,
        linkActive: true,
        error: "Failed to fetch Forge status",
      });
    });
  });

  describe("GET /api/companies/:companyId/forge/charters/:changeId/issue", () => {
    it("resolves linked issue by company and change_id (200)", async () => {
      const app = await createTestApp();

      mockResolveIssueByChangeId.mockResolvedValueOnce({
        id: "issue-123",
        identifier: "PAP-123",
        title: "Linked Issue",
        status: "in_progress",
        originKind: "forge_charter",
        originId: "change-1",
      });

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
    });

    it("returns 404 when no linked issue exists", async () => {
      const app = await createTestApp();

      mockResolveIssueByChangeId.mockResolvedValueOnce(null);

      const response = await request(app)
        .get("/api/companies/company-1/forge/charters/unknown-change/issue")
        .set("Accept", "application/json");

      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/companies/:companyId/forge/charters/:changeId/sync-issue", () => {
    it("creates a new issue when none exists for the change_id (201)", async () => {
      const app = await createTestApp();

      mockSyncForgeCharterToIssue.mockResolvedValueOnce({
        issue: {
          id: "new-issue-id",
          identifier: "PAP-789",
          title: "Custom Title",
          status: "backlog",
          originKind: "forge_charter",
          originId: "new-change",
        },
        created: true,
        changeId: "new-change",
      });

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
      expect(mockSyncForgeCharterToIssue).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId: "company-1",
          changeId: "new-change",
          title: "Custom Title",
          description: "Test description",
        })
      );
    });

    it("returns existing issue when already linked (200 created=false)", async () => {
      const app = await createTestApp();

      mockSyncForgeCharterToIssue.mockResolvedValueOnce({
        issue: {
          id: "existing-issue",
          identifier: "PAP-456",
          title: "Existing Linked Issue",
          status: "in_progress",
          originKind: "forge_charter",
          originId: "existing-change",
        },
        created: false,
        changeId: "existing-change",
      });

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

describe("completion guard preservation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, FORGE_API_URL: "http://forge.test" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("linked issue + Forge in_progress blocks with 409 via PATCH /issues/:id", async () => {
    const app = await createTestApp();

    mockIssueService.getById.mockResolvedValueOnce({
      id: "linked-issue",
      companyId: "company-1",
      status: "in_progress",
      originKind: "forge_charter",
      originId: "change-1",
    });

    mockIsForgeLinkedIssue.mockReturnValueOnce(true);
    mockShouldGuardIssueCompletion.mockReturnValueOnce(true);

    const { ForgeCompletionGuardError } = await import("../services/forge-completion-guard.js");
    const guardError = new ForgeCompletionGuardError(
      'Cannot complete Forge-linked issue: Forge status is "in_progress" (requires "verified" or "archived")',
      "FORGE_STATUS_UNVERIFIED",
      "change-1"
    ) as any;
    guardError.status = 409;
    mockAssertForgeIssueCompletionAllowed.mockRejectedValueOnce(guardError);

    const response = await request(app)
      .patch("/api/issues/linked-issue")
      .send({ status: "done" })
      .set("Accept", "application/json");

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("in_progress"),
      code: "FORGE_STATUS_UNVERIFIED",
      changeId: "change-1",
    });
  });

  it("shouldGuardIssueCompletion returns true for status transition to done", async () => {
    const { shouldGuardIssueCompletion } = await vi.importActual<typeof import("../services/forge-completion-guard.js")>("../services/forge-completion-guard.js");

    // Should guard when transitioning from in_progress to done
    expect(shouldGuardIssueCompletion("in_progress", "done")).toBe(true);
    expect(shouldGuardIssueCompletion("backlog", "done")).toBe(true);
    expect(shouldGuardIssueCompletion("todo", "done")).toBe(true);

    // Should not guard when status is not changing to done
    expect(shouldGuardIssueCompletion("in_progress", "blocked")).toBe(false);
    expect(shouldGuardIssueCompletion("done", "archived")).toBe(false);
    expect(shouldGuardIssueCompletion("in_progress", undefined)).toBe(false);
  });

  it("isForgeLinkedIssue returns true for forge_charter origin", async () => {
    const { isForgeLinkedIssue } = await vi.importActual<typeof import("../services/forge-completion-guard.js")>("../services/forge-completion-guard.js");

    expect(isForgeLinkedIssue({ originKind: "forge_charter", originId: "change-1" } as any)).toBe(true);
    expect(isForgeLinkedIssue({ originKind: null, originId: null } as any)).toBe(false);
    expect(isForgeLinkedIssue({ originKind: "github", originId: "123" } as any)).toBe(false);
  });
});
