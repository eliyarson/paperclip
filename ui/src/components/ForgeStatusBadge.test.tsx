// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ForgeStatusBadge, ForgeStatusBadgeCompact, useForgeLinkStatus } from "./ForgeStatusBadge";
import { issuesApi, type ForgeLinkStatus } from "../api/issues";

// Mock the API
vi.mock("../api/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/issues")>();
  return {
    ...actual,
    issuesApi: {
      ...actual.issuesApi,
      getForgeLink: vi.fn(),
    },
  };
});

// Mock the queryKeys
vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    issues: {
      forgeLink: (id: string) => ["issues", "forge-link", id],
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createMockIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-123",
    companyId: "company-456",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Test Issue",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "TEST-1",
    originKind: undefined,
    originId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
      },
    },
  });
}

function renderWithQuery(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = createQueryClient();

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        {ui}
      </QueryClientProvider>
    );
  });

  return { container, root, queryClient };
}

describe("ForgeStatusBadge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Cleanup
    document.body.innerHTML = "";
  });

  describe("unlinked issues", () => {
    it("should not render anything for issues without forge_charter originKind", () => {
      const issue = createMockIssue({ originKind: undefined, originId: null });
      const { container } = renderWithQuery(<ForgeStatusBadge issue={issue} />);

      // Badge should not render anything for unlinked issues
      const badge = container.querySelector("[title^='Forge']");
      expect(badge).toBeNull();
    });

    it("should not render anything for forge_charter issues without originId", () => {
      const issue = createMockIssue({ originKind: "forge_charter", originId: null });
      const { container } = renderWithQuery(<ForgeStatusBadge issue={issue} />);

      const badge = container.querySelector("[title^='Forge']");
      expect(badge).toBeNull();
    });

    it("should not render anything for issues with empty originId", () => {
      const issue = createMockIssue({ originKind: "forge_charter", originId: "" });
      const { container } = renderWithQuery(<ForgeStatusBadge issue={issue} />);

      const badge = container.querySelector("[title^='Forge']");
      expect(badge).toBeNull();
    });
  });

  describe("linked issues - loading state", () => {
    it("should show loading state while fetching", async () => {
      const issue = createMockIssue({ originKind: "forge_charter", originId: "change-abc123" });

      // Delay the API response
      vi.mocked(issuesApi.getForgeLink).mockImplementation(() => new Promise(() => {}));

      const { container } = renderWithQuery(<ForgeStatusBadge issue={issue} />);

      // Should show loading indicator
      const loadingElement = container.querySelector("[title='Loading Forge status...']");
      expect(loadingElement).not.toBeNull();
    });
  });

  describe("linked issues - success state", () => {
    it("should display change_id and status when Forge returns data", async () => {
      const issue = createMockIssue({ originKind: "forge_charter", originId: "change-abc123" });

      vi.mocked(issuesApi.getForgeLink).mockResolvedValue({
        issueId: issue.id,
        changeId: "change-abc123",
        forgeStatus: "verified",
        linkActive: true,
      });

      const { container } = renderWithQuery(<ForgeStatusBadge issue={issue} />);

      // Wait for the API call to resolve
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      // Should show the truncated change_id (first 8 chars)
      expect(container.textContent).toContain("change-a");
    });

    it("should call API with correct issue ID", async () => {
      const issue = createMockIssue({ originKind: "forge_charter", originId: "change-abc123" });

      vi.mocked(issuesApi.getForgeLink).mockResolvedValue({
        issueId: issue.id,
        changeId: "change-abc123",
        forgeStatus: "verified",
        linkActive: true,
      });

      renderWithQuery(<ForgeStatusBadge issue={issue} />);

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(issuesApi.getForgeLink).toHaveBeenCalledWith(issue.id);
    });
  });

  describe("linked issues - error state", () => {
    it("should show error badge when API returns error", async () => {
      const issue = createMockIssue({ originKind: "forge_charter", originId: "change-abc123" });

      vi.mocked(issuesApi.getForgeLink).mockResolvedValue({
        issueId: issue.id,
        changeId: "change-abc123",
        forgeStatus: null,
        linkActive: true,
        error: "Forge status unavailable",
      });

      const { container } = renderWithQuery(<ForgeStatusBadge issue={issue} />);

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const errorElement = container.querySelector("[title='Forge status unavailable']");
      expect(errorElement).not.toBeNull();
    });

    it("should show error badge when link is not active", async () => {
      const issue = createMockIssue({ originKind: "forge_charter", originId: "change-abc123" });

      vi.mocked(issuesApi.getForgeLink).mockResolvedValue({
        issueId: issue.id,
        changeId: "change-abc123",
        forgeStatus: null,
        linkActive: false,
        error: "Issue is not linked to a Forge Charter",
      });

      const { container } = renderWithQuery(<ForgeStatusBadge issue={issue} />);

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const errorElement = container.querySelector("[title='Issue is not linked to a Forge Charter']");
      expect(errorElement).not.toBeNull();
    });
  });

  describe("API boundary", () => {
    it("should only call Paperclip API, not Forge directly", async () => {
      const issue = createMockIssue({ originKind: "forge_charter", originId: "change-abc123" });

      vi.mocked(issuesApi.getForgeLink).mockResolvedValue({
        issueId: issue.id,
        changeId: "change-abc123",
        forgeStatus: "verified",
        linkActive: true,
      });

      renderWithQuery(<ForgeStatusBadge issue={issue} />);

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      // Verify it was called with the issue ID
      expect(issuesApi.getForgeLink).toHaveBeenCalledTimes(1);
      expect(issuesApi.getForgeLink).toHaveBeenCalledWith(issue.id);
    });
  });

  describe("compact variant", () => {
    it("should not render for unlinked issues", () => {
      const issue = createMockIssue({ originKind: undefined, originId: null });
      const { container } = renderWithQuery(<ForgeStatusBadgeCompact issue={issue} />);

      const badge = container.querySelector("[title^='Forge']");
      expect(badge).toBeNull();
    });

    it("should show compact loading state", async () => {
      const issue = createMockIssue({ originKind: "forge_charter", originId: "change-abc123" });

      vi.mocked(issuesApi.getForgeLink).mockImplementation(() => new Promise(() => {}));

      const { container } = renderWithQuery(<ForgeStatusBadgeCompact issue={issue} />);

      const loadingElement = container.querySelector("[title='Loading Forge status...']");
      expect(loadingElement).not.toBeNull();
    });
  });
});
