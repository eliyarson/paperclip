import { describe, expect, it } from "vitest";
import {
  assertRoleIssueCompletionAllowed,
  hasCompletedDelegatedChildWork,
  hasNonEmptyPlanDocument,
  isCodeScopedProject,
  isPlanningAgentRole,
  RoleCompletionGuardError,
  shouldGuardPlanningRoleCompletion,
} from "../services/role-completion-guard.js";

const issue = {
  id: "issue-1",
  companyId: "company-1",
  projectId: "project-1",
  status: "in_progress",
};

const codeProject = {
  id: "project-1",
  codebase: { localFolder: "/repo", repoUrl: null, workspaceId: "workspace-1" },
};

describe("role completion guard", () => {
  it("detects planning-role done transitions", () => {
    expect(shouldGuardPlanningRoleCompletion("in_progress", "done")).toBe(true);
    expect(shouldGuardPlanningRoleCompletion("done", "done")).toBe(false);
    expect(shouldGuardPlanningRoleCompletion("in_progress", "blocked")).toBe(false);
    expect(isPlanningAgentRole("pm")).toBe(true);
    expect(isPlanningAgentRole("product-manager")).toBe(true);
    expect(isPlanningAgentRole("engineer")).toBe(false);
  });

  it("detects code-scoped projects and completion evidence", () => {
    expect(isCodeScopedProject(codeProject)).toBe(true);
    expect(isCodeScopedProject({ id: "project-2", codebase: null })).toBe(false);
    expect(hasNonEmptyPlanDocument({ body: "# Plan" })).toBe(true);
    expect(hasNonEmptyPlanDocument({ body: "   " })).toBe(false);
    expect(hasCompletedDelegatedChildWork([{ id: "child-1", status: "done" }])).toBe(true);
    expect(hasCompletedDelegatedChildWork([{ id: "child-1", status: "in_progress" }])).toBe(false);
    expect(hasCompletedDelegatedChildWork([{ id: "child-1", status: "cancelled" }])).toBe(false);
  });

  it("blocks PM completion of code-scoped issues without plan and delegated child work", async () => {
    await expect(assertRoleIssueCompletionAllowed({
      issue,
      requestedStatus: "done",
      actorAgent: { id: "agent-1", role: "pm" },
      getProject: async () => codeProject,
      getPlanDocument: async () => null,
      listChildren: async () => [],
    })).rejects.toBeInstanceOf(RoleCompletionGuardError);
  });

  it("allows PM completion after plan and delegated child work are complete", async () => {
    await expect(assertRoleIssueCompletionAllowed({
      issue,
      requestedStatus: "done",
      actorAgent: { id: "agent-1", role: "pm" },
      getProject: async () => codeProject,
      getPlanDocument: async () => ({ body: "# Plan" }),
      listChildren: async () => [{ id: "child-1", status: "done" }],
    })).resolves.toBeUndefined();
  });

  it("does not block engineering roles", async () => {
    await expect(assertRoleIssueCompletionAllowed({
      issue,
      requestedStatus: "done",
      actorAgent: { id: "agent-1", role: "engineer" },
      getProject: async () => codeProject,
      getPlanDocument: async () => null,
      listChildren: async () => [],
    })).resolves.toBeUndefined();
  });
});
