import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { forgeAdapter } from "./index.js";
import {
  redactSensitiveValues,
  redactSensitiveObject,
  redactHeadersForLogging,
  safeErrorStringify,
  normalizeForgeUrl,
  buildForgeEndpoint,
} from "./utils.js";

// =============================================================================
// MOCKS
// =============================================================================

afterEach(() => {
  vi.unstubAllGlobals();
});

// =============================================================================
// REGISTRATION AND CONFIG SCHEMA TESTS
// =============================================================================

describe("registration and config", () => {
  it("exports forge adapter with correct type", () => {
    expect(forgeAdapter.type).toBe("forge");
  });

  it("provides agent configuration documentation", () => {
    expect(forgeAdapter.agentConfigurationDoc).toBeDefined();
    expect(forgeAdapter.agentConfigurationDoc).toContain("Forge agent configuration");
    expect(forgeAdapter.agentConfigurationDoc).toContain("forgeApiUrl");
    expect(forgeAdapter.agentConfigurationDoc).toContain("forgeApiToken");
  });

  it("provides declarative config schema", async () => {
    const schema = await forgeAdapter.getConfigSchema?.();
    expect(schema).toBeDefined();
    expect(schema?.fields).toBeDefined();
    expect(schema?.fields.length).toBeGreaterThan(0);

    // Check required fields exist
    const fieldKeys = schema?.fields.map((f) => f.key);
    expect(fieldKeys).toContain("forgeApiUrl");
    expect(fieldKeys).toContain("forgeApiToken");
    expect(fieldKeys).toContain("organizationId");
    expect(fieldKeys).toContain("workspaceId");
    expect(fieldKeys).toContain("projectId");
    expect(fieldKeys).toContain("workerId");
    expect(fieldKeys).toContain("changeId");

    // Check required flags
    const urlField = schema?.fields.find((f) => f.key === "forgeApiUrl");
    expect(urlField?.required).toBe(true);

    const tokenField = schema?.fields.find((f) => f.key === "forgeApiToken");
    expect(tokenField?.required).toBe(true);

    const changeIdField = schema?.fields.find((f) => f.key === "changeId");
    expect(changeIdField?.required).toBe(false);
  });

  it("has execute function", () => {
    expect(typeof forgeAdapter.execute).toBe("function");
  });

  it("has testEnvironment function", () => {
    expect(typeof forgeAdapter.testEnvironment).toBe("function");
  });

  it("declares correct capability flags", () => {
    expect(forgeAdapter.supportsLocalAgentJwt).toBe(false);
    expect(forgeAdapter.supportsInstructionsBundle).toBe(false);
    expect(forgeAdapter.requiresMaterializedRuntimeSkills).toBe(false);
  });
});

// =============================================================================
// ENVIRONMENT CHECKS TESTS
// =============================================================================

describe("environment checks", () => {
  it("fails closed when forgeApiUrl is missing", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "forge",
      config: {
        forgeApiToken: "secret-token",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "forge_url_missing" && c.level === "error")).toBe(
      true,
    );
  });

  it("fails closed when forgeApiToken is missing", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "forge",
      config: {
        forgeApiUrl: "http://forge.test",
      },
    });

    expect(result.status).toBe("fail");
    expect(
      result.checks.some((c) => c.code === "forge_token_missing" && c.level === "error"),
    ).toBe(true);
  });

  it("fails closed when forgeApiUrl is malformed", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "forge",
      config: {
        forgeApiUrl: "not-a-valid-url",
        forgeApiToken: "secret-token",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "forge_url_invalid" && c.level === "error")).toBe(
      true,
    );
  });

  it("fails closed when forgeApiUrl has invalid protocol", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "forge",
      config: {
        forgeApiUrl: "ftp://forge.test",
        forgeApiToken: "secret-token",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "forge_url_invalid" && c.level === "error")).toBe(
      true,
    );
  });

  it("warns when organizationId is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok" }),
      } as Response),
    );

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "forge",
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret-token",
      },
    });

    expect(result.checks.some((c) => c.code === "forge_org_missing" && c.level === "warn")).toBe(
      true,
    );
  });

  it("warns when workspaceId is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok" }),
      } as Response),
    );

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "forge",
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret-token",
      },
    });

    expect(
      result.checks.some((c) => c.code === "forge_workspace_missing" && c.level === "warn"),
    ).toBe(true);
  });

  it("passes when all required config is valid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok" }),
      } as Response),
    );

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "forge",
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret-token",
        organizationId: "org-1",
        workspaceId: "workspace-1",
      },
    });

    expect(result.status).toBe("pass");
    expect(
      result.checks.some((c) => c.code === "forge_url_valid" && c.level === "info"),
    ).toBe(true);
    expect(
      result.checks.some((c) => c.code === "forge_token_configured" && c.level === "info"),
    ).toBe(true);
  });

  it("fails closed when Forge API returns non-2xx error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      } as Response),
    );

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "forge",
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret-token",
        organizationId: "org-1",
        workspaceId: "workspace-1",
      },
    });

    // Non-2xx response should result in "fail" status
    expect(result.status).toBe("fail");
    expect(
      result.checks.some((c) => c.code === "forge_connectivity_unexpected" && c.level === "error"),
    ).toBe(true);
  });

  it("fails closed when Forge API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Connection refused")),
    );

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "forge",
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret-token",
        organizationId: "org-1",
        workspaceId: "workspace-1",
      },
    });

    // Connectivity failure should result in "fail" status
    expect(result.status).toBe("fail");
    expect(
      result.checks.some((c) => c.code === "forge_connectivity_failed" && c.level === "error"),
    ).toBe(true);
  });

  it("does not expose token values in error messages", async () => {
    const secretToken = "super-secret-token-xyz-123";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error(`Auth failed with token: ${secretToken}`)),
    );

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "forge",
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: secretToken,
      },
    });

    // Check that no check message contains the secret token
    for (const check of result.checks) {
      if (check.message) {
        expect(check.message).not.toContain(secretToken);
      }
      if (check.hint) {
        expect(check.hint).not.toContain(secretToken);
      }
    }
  });
});

// =============================================================================
// EXECUTE BRIDGE TESTS
// =============================================================================

describe("execute bridge", () => {
  const baseContext = {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Test Agent",
      adapterType: "forge",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    context: {},
    onLog: async () => {},
  };

  it("returns error when forgeApiUrl is missing", async () => {
    const result = await execute({
      ...baseContext,
      config: {
        forgeApiToken: "secret",
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("forge_config_missing_url");
  });

  it("returns error when forgeApiToken is missing", async () => {
    const result = await execute({
      ...baseContext,
      config: {
        forgeApiUrl: "http://forge.test",
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("forge_config_missing_token");
  });

  it("returns error when change_id cannot be resolved", async () => {
    const result = await execute({
      ...baseContext,
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret",
      },
      context: {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("forge_change_id_unresolved");
  });

  it("resolves change_id from linked issue context", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "in_progress" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ worker_id: "worker-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ task_id: "task-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ heartbeat_ack: true }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ evidence_id: "evidence-1" }),
      } as Response);

    vi.stubGlobal("fetch", mockFetch);

    const result = await execute({
      ...baseContext,
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret",
      },
      context: {
        issue: {
          originKind: "forge_charter",
          originId: "change-123",
        },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.resultJson).toMatchObject({
      changeId: "change-123",
      forgeStatus: "in_progress",
    });

    // Verify the change endpoint was called
    expect(mockFetch).toHaveBeenCalledWith(
      "http://forge.test/api/spec/changes/change-123",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "Accept": "application/json",
          "Authorization": "Bearer secret",
        }),
      }),
    );

    // Verify heartbeat was called
    expect(mockFetch).toHaveBeenCalledWith(
      "http://forge.test/api/spec/tasks/heartbeat",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("falls back to config changeId when no linked issue", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "verified" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ worker_id: "worker-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ task_id: "task-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ heartbeat_ack: true }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ evidence_id: "evidence-1" }),
      } as Response);

    vi.stubGlobal("fetch", mockFetch);

    const result = await execute({
      ...baseContext,
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret",
        changeId: "fallback-change-456",
      },
      context: {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.resultJson).toMatchObject({
      changeId: "fallback-change-456",
    });
  });

  it("prefers linked issue over config fallback", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "in_progress" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ worker_id: "worker-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ task_id: "task-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ heartbeat_ack: true }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ evidence_id: "evidence-1" }),
      } as Response);

    vi.stubGlobal("fetch", mockFetch);

    const result = await execute({
      ...baseContext,
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret",
        changeId: "config-fallback",
      },
      context: {
        issue: {
          originKind: "forge_charter",
          originId: "linked-change-789",
        },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.resultJson).toMatchObject({
      changeId: "linked-change-789",
    });
  });

  it("calls all required Forge HTTP endpoints including heartbeat", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "in_progress" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ worker_id: "worker-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ task_id: "task-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ heartbeat_ack: true }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ evidence_id: "evidence-1" }),
      } as Response);

    vi.stubGlobal("fetch", mockFetch);

    await execute({
      ...baseContext,
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret",
        organizationId: "org-1",
        workspaceId: "workspace-1",
      },
      context: {
        issue: {
          originKind: "forge_charter",
          originId: "change-123",
        },
      },
    });

    // Verify all endpoints were called (5 calls: change, worker, task, heartbeat, evidence)
    expect(mockFetch).toHaveBeenCalledTimes(5);

    const calls = mockFetch.mock.calls;
    expect(calls[0][0]).toBe("http://forge.test/api/spec/changes/change-123");
    expect(calls[1][0]).toBe("http://forge.test/api/spec/workers/register");
    expect(calls[2][0]).toBe("http://forge.test/api/spec/tasks/claim");
    expect(calls[3][0]).toBe("http://forge.test/api/spec/tasks/heartbeat");
    expect(calls[4][0]).toBe("http://forge.test/api/spec/evidence");
  });

  it("maps 5xx errors to retryable adapter errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      } as Response),
    );

    const result = await execute({
      ...baseContext,
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret",
      },
      context: {
        issue: {
          originKind: "forge_charter",
          originId: "change-123",
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("forge_api_retryable");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.retryNotBefore).toBeDefined();
  });

  it("maps 4xx errors to non-retryable adapter errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      } as Response),
    );

    const result = await execute({
      ...baseContext,
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret",
      },
      context: {
        issue: {
          originKind: "forge_charter",
          originId: "change-123",
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("forge_api_error");
    expect(result.errorFamily).toBeNull();
    expect(result.retryNotBefore).toBeNull();
  });

  it("maps network errors to retryable adapter errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const result = await execute({
      ...baseContext,
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret",
      },
      context: {
        issue: {
          originKind: "forge_charter",
          originId: "change-123",
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("forge_execution_retryable");
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("continues execution even when worker registration fails", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "in_progress" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Server Error",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ task_id: "task-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ evidence_id: "evidence-1" }),
      } as Response);

    vi.stubGlobal("fetch", mockFetch);

    const result = await execute({
      ...baseContext,
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret",
      },
      context: {
        issue: {
          originKind: "forge_charter",
          originId: "change-123",
        },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.resultJson).toMatchObject({
      changeId: "change-123",
    });
  });

  it("continues execution even when task claim fails", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "in_progress" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ worker_id: "worker-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        statusText: "Conflict",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ evidence_id: "evidence-1" }),
      } as Response);

    vi.stubGlobal("fetch", mockFetch);

    const result = await execute({
      ...baseContext,
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret",
      },
      context: {
        issue: {
          originKind: "forge_charter",
          originId: "change-123",
        },
      },
    });

    expect(result.exitCode).toBe(0);
  });

  it("continues execution even when evidence attachment fails", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "in_progress" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ worker_id: "worker-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ task_id: "task-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ heartbeat_ack: true }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Server Error",
      } as Response);

    vi.stubGlobal("fetch", mockFetch);

    const result = await execute({
      ...baseContext,
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret",
      },
      context: {
        issue: {
          originKind: "forge_charter",
          originId: "change-123",
        },
      },
    });

    expect(result.exitCode).toBe(0);
  });

  it("skips heartbeat when task claim fails", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "in_progress" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ worker_id: "worker-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        statusText: "Conflict",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ evidence_id: "evidence-1" }),
      } as Response);

    vi.stubGlobal("fetch", mockFetch);

    const result = await execute({
      ...baseContext,
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret",
      },
      context: {
        issue: {
          originKind: "forge_charter",
          originId: "change-123",
        },
      },
    });

    expect(result.exitCode).toBe(0);
    // Should not call heartbeat when task claim fails (only 4 calls: change, worker, task, evidence)
    expect(mockFetch).toHaveBeenCalledTimes(4);
    const calls = mockFetch.mock.calls;
    expect(calls[3][0]).toBe("http://forge.test/api/spec/evidence");
  });

  it("fails closed when heartbeat returns 5xx error", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "in_progress" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ worker_id: "worker-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ task_id: "task-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      } as Response);

    vi.stubGlobal("fetch", mockFetch);

    const result = await execute({
      ...baseContext,
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret",
      },
      context: {
        issue: {
          originKind: "forge_charter",
          originId: "change-123",
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("forge_heartbeat_retryable");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.retryNotBefore).toBeDefined();
  });

  it("fails closed when heartbeat returns 4xx error", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "in_progress" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ worker_id: "worker-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ task_id: "task-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      } as Response);

    vi.stubGlobal("fetch", mockFetch);

    const result = await execute({
      ...baseContext,
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret",
      },
      context: {
        issue: {
          originKind: "forge_charter",
          originId: "change-123",
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("forge_heartbeat_failed");
    expect(result.errorFamily).toBeNull();
    expect(result.retryNotBefore).toBeNull();
  });

  it("fails closed with retryable error when heartbeat network fails", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "in_progress" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ worker_id: "worker-1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ task_id: "task-1" }),
      } as Response)
      .mockRejectedValueOnce(new Error("Network error during heartbeat"));

    vi.stubGlobal("fetch", mockFetch);

    const result = await execute({
      ...baseContext,
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: "secret",
      },
      context: {
        issue: {
          originKind: "forge_charter",
          originId: "change-123",
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("forge_heartbeat_retryable");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.retryNotBefore).toBeDefined();
  });
});

// =============================================================================
// TOKEN REDACTION TESTS
// =============================================================================

describe("token redaction", () => {
  it("redacts bearer tokens in strings", () => {
    const input = "Authorization: Bearer secret-token-123";
    const result = redactSensitiveValues(input);
    // Both the bearer pattern and authorization pattern match
    expect(result).not.toContain("secret-token-123");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts token values in strings", () => {
    const input = 'token: "secret-value-abc"';
    const result = redactSensitiveValues(input);
    expect(result).not.toContain("secret-value-abc");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts apiToken values in strings", () => {
    const input = "apiToken=super-secret-xyz";
    const result = redactSensitiveValues(input);
    expect(result).toBe("apiToken=[REDACTED]");
  });

  it("redacts forgeApiToken values in strings", () => {
    const input = "forgeApiToken: my-secret-token";
    const result = redactSensitiveValues(input);
    expect(result).toBe("forgeApiToken: [REDACTED]");
  });

  it("redacts sensitive keys in objects", () => {
    const input = {
      forgeApiUrl: "http://forge.test",
      forgeApiToken: "secret-token-123",
      organizationId: "org-1",
    };
    const result = redactSensitiveObject(input);
    expect(result.forgeApiToken).toBe("[REDACTED]");
    expect(result.forgeApiUrl).toBe("http://forge.test");
    expect(result.organizationId).toBe("org-1");
  });

  it("redacts nested sensitive values", () => {
    const input = {
      config: {
        forgeApiToken: "nested-secret",
        url: "http://test",
      },
    };
    const result = redactSensitiveObject(input);
    expect(result.config).toMatchObject({
      forgeApiToken: "[REDACTED]",
      url: "http://test",
    });
  });

  it("redacts Authorization headers", () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer secret-token",
      Accept: "application/json",
    };
    const result = redactHeadersForLogging(headers);
    expect(result.Authorization).toBe("[REDACTED]");
    expect(result["Content-Type"]).toBe("application/json");
  });

  it("safely stringifies errors without leaking tokens", () => {
    const error = new Error(`Request failed with token: secret-abc-123`);
    const result = safeErrorStringify(error);
    expect(result).not.toContain("secret-abc-123");
    expect(result).toContain("[REDACTED]");
  });

  it("does not expose token in execute error messages", async () => {
    const secretToken = "super-secret-token-xyz-789";

    // Use a bearer token pattern that will be redacted
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error(`Request failed with Authorization: Bearer ${secretToken}`)),
    );

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "forge",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: secretToken,
      },
      context: {
        issue: {
          originKind: "forge_charter",
          originId: "change-123",
        },
      },
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(1);
    // The bearer token pattern should be redacted
    expect(result.errorMessage).not.toContain(secretToken);
    expect(result.errorMessage).toContain("[REDACTED]");
  });

  it("does not expose token in resultJson", async () => {
    const secretToken = "super-secret-token-xyz-789";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "in_progress" }),
      } as Response),
    );

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "forge",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        forgeApiUrl: "http://forge.test",
        forgeApiToken: secretToken,
        organizationId: "org-1",
      },
      context: {
        issue: {
          originKind: "forge_charter",
          originId: "change-123",
        },
      },
      onLog: async () => {},
    });

    const resultJsonStr = JSON.stringify(result.resultJson);
    expect(resultJsonStr).not.toContain(secretToken);
  });
});

// =============================================================================
// UTILITY FUNCTION TESTS
// =============================================================================

describe("utility functions", () => {
  describe("normalizeForgeUrl", () => {
    it("returns valid URL for http URLs", () => {
      const result = normalizeForgeUrl("http://forge.test");
      expect(result).toBeInstanceOf(URL);
      // URL.toString() may include trailing slash
      expect(result?.origin).toBe("http://forge.test");
    });

    it("returns valid URL for https URLs", () => {
      const result = normalizeForgeUrl("https://forge.test/api");
      expect(result).toBeInstanceOf(URL);
      expect(result?.pathname).toBe("/api");
    });

    it("handles trailing slash", () => {
      const result = normalizeForgeUrl("http://forge.test/");
      expect(result).toBeInstanceOf(URL);
      expect(result?.origin).toBe("http://forge.test");
    });

    it("returns null for ftp URLs", () => {
      const result = normalizeForgeUrl("ftp://forge.test");
      expect(result).toBeNull();
    });

    it("returns null for invalid URLs", () => {
      const result = normalizeForgeUrl("not a url");
      expect(result).toBeNull();
    });
  });

  describe("buildForgeEndpoint", () => {
    it("builds correct endpoint URL", () => {
      const result = buildForgeEndpoint("http://forge.test", "/api/spec/changes/123");
      expect(result).toBe("http://forge.test/api/spec/changes/123");
    });

    it("handles base URL with trailing slash", () => {
      const result = buildForgeEndpoint("http://forge.test/", "/api/spec/changes/123");
      expect(result).toBe("http://forge.test/api/spec/changes/123");
    });

    it("throws for invalid base URL", () => {
      expect(() => buildForgeEndpoint("invalid-url", "/api/spec")).toThrow("Invalid Forge API URL");
    });
  });
});
