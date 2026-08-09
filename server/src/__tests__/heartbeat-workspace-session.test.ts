import { describe, expect, it } from "vitest";
import type { agents } from "@paperclipai/db";
import { sessionCodec as codexSessionCodec } from "@paperclipai/adapter-codex-local/server";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import {
  applyPersistedExecutionWorkspaceConfig,
  buildRealizedExecutionWorkspaceFromPersisted,
  buildExplicitResumeSessionOverride,
  deriveSessionTaskKey,
  deriveTaskKey,
  deriveTaskKeyWithHeartbeatFallback,
  extractWakeCommentIds,
  formatRuntimeWorkspaceWarningLog,
  mergeExecutionWorkspaceMetadataForPersistence,
  mergeCoalescedContextSnapshot,
  prioritizeProjectWorkspaceCandidatesForRun,
  parseSessionCompactionPolicy,
  resolveRuntimeSessionParamsForWorkspace,
  stripWorkspaceRuntimeFromExecutionRunConfig,
  shouldResetTaskSessionForWake,
  type ResolvedWorkspaceForRun,
} from "../services/heartbeat.ts";

function buildResolvedWorkspace(overrides: Partial<ResolvedWorkspaceForRun> = {}): ResolvedWorkspaceForRun {
  return {
    cwd: "/tmp/project",
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: null,
    repoRef: null,
    workspaceHints: [],
    warnings: [],
    ...overrides,
  };
}

function buildAgent(adapterType: string, runtimeConfig: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: "company-1",
    projectId: null,
    goalId: null,
    name: "Agent",
    role: "engineer",
    title: null,
    icon: null,
    status: "running",
    reportsTo: null,
    capabilities: null,
    adapterType,
    adapterConfig: {},
    runtimeConfig,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as typeof agents.$inferSelect;
}

describe("resolveRuntimeSessionParamsForWorkspace", () => {
  it("migrates fallback workspace sessions to project workspace when project cwd becomes available", () => {
    const agentId = "agent-123";
    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agentId);

    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: fallbackCwd,
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: "/tmp/new-project-cwd" }),
    });

    expect(result.sessionParams).toMatchObject({
      sessionId: "session-1",
      cwd: "/tmp/new-project-cwd",
      workspaceId: "workspace-1",
    });
    expect(result.warning).toContain("Attempting to resume session");
  });

  it("does not migrate when previous session cwd is not the fallback workspace", () => {
    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId: "agent-123",
      previousSessionParams: {
        sessionId: "session-1",
        cwd: "/tmp/some-other-cwd",
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: "/tmp/new-project-cwd" }),
    });

    expect(result.sessionParams).toEqual({
      sessionId: "session-1",
      cwd: "/tmp/some-other-cwd",
      workspaceId: "workspace-1",
    });
    expect(result.warning).toBeNull();
  });

  it("does not migrate when resolved workspace id differs from previous session workspace id", () => {
    const agentId = "agent-123";
    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agentId);

    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: fallbackCwd,
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({
        cwd: "/tmp/new-project-cwd",
        workspaceId: "workspace-2",
      }),
    });

    expect(result.sessionParams).toEqual({
      sessionId: "session-1",
      cwd: fallbackCwd,
      workspaceId: "workspace-1",
    });
    expect(result.warning).toBeNull();
  });
});

describe("applyPersistedExecutionWorkspaceConfig", () => {
  it("does not add workspace runtime when only the project workspace had manual runtime config", () => {
    const result = applyPersistedExecutionWorkspaceConfig({
      config: {},
      workspaceConfig: null,
      mode: "isolated_workspace",
    });

    expect("workspaceRuntime" in result).toBe(false);
  });

  it("applies explicit persisted execution workspace runtime config when present", () => {
    const result = applyPersistedExecutionWorkspaceConfig({
      config: {},
      workspaceConfig: {
        provisionCommand: null,
        teardownCommand: null,
        cleanupCommand: null,
        desiredState: null,
        workspaceRuntime: {
          services: [{ name: "workspace-web" }],
        },
      },
      mode: "isolated_workspace",
    });

    expect(result.workspaceRuntime).toEqual({
      services: [{ name: "workspace-web" }],
    });
  });
});

describe("mergeExecutionWorkspaceMetadataForPersistence", () => {
  it("merges config snapshot for newly realized workspaces", () => {
    expect(mergeExecutionWorkspaceMetadataForPersistence({
      existingMetadata: null,
      source: "task_session",
      createdByRuntime: true,
      configSnapshot: {
        environmentId: "env-new",
        provisionCommand: "bash ./scripts/provision.sh",
      },
      shouldReuseExisting: false,
    })).toEqual({
      source: "task_session",
      createdByRuntime: true,
      config: {
        environmentId: "env-new",
        provisionCommand: "bash ./scripts/provision.sh",
        teardownCommand: null,
        cleanupCommand: null,
        desiredState: null,
        serviceStates: null,
        workspaceRuntime: null,
      },
    });
  });

  it("preserves persisted config snapshot when reusing an existing workspace", () => {
    expect(mergeExecutionWorkspaceMetadataForPersistence({
      existingMetadata: {
        config: {
          environmentId: "env-old",
          provisionCommand: "bash ./scripts/existing-provision.sh",
        },
      },
      source: "task_session",
      createdByRuntime: false,
      configSnapshot: {
        environmentId: "env-new",
        provisionCommand: "bash ./scripts/new-provision.sh",
      },
      shouldReuseExisting: true,
    })).toEqual({
      config: {
        environmentId: "env-old",
        provisionCommand: "bash ./scripts/existing-provision.sh",
      },
      source: "task_session",
      createdByRuntime: false,
    });
  });
});

describe("buildRealizedExecutionWorkspaceFromPersisted", () => {
  it("reuses the persisted execution workspace path instead of deriving a new worktree", () => {
    const result = buildRealizedExecutionWorkspaceFromPersisted({
      base: buildResolvedWorkspace({
        cwd: "/tmp/project-primary",
        repoRef: "main",
      }),
      workspace: {
        id: "execution-workspace-1",
        companyId: "company-1",
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        sourceIssueId: "issue-1",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "PAP-880-thumbs-capture-for-evals-feature",
        status: "active",
        cwd: "/tmp/reused-worktree",
        repoUrl: "https://example.com/paperclip.git",
        baseRef: "main",
        branchName: "PAP-880-thumbs-capture-for-evals-feature",
        providerType: "git_worktree",
        providerRef: "/tmp/reused-worktree",
        derivedFromExecutionWorkspaceId: null,
        lastUsedAt: new Date(),
        openedAt: new Date(),
        closedAt: null,
        cleanupEligibleAt: null,
        cleanupReason: null,
        config: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    expect(result.created).toBe(false);
    expect(result.strategy).toBe("git_worktree");
    expect(result.cwd).toBe("/tmp/reused-worktree");
    expect(result.worktreePath).toBe("/tmp/reused-worktree");
    expect(result.branchName).toBe("PAP-880-thumbs-capture-for-evals-feature");
    expect(result.source).toBe("task_session");
  });
});

describe("stripWorkspaceRuntimeFromExecutionRunConfig", () => {
  it("removes workspace runtime before heartbeat execution", () => {
    const input = {
      cwd: "/tmp/project",
      workspaceStrategy: {
        type: "git_worktree",
      },
      workspaceRuntime: {
        services: [{ name: "web" }],
      },
    };

    const result = stripWorkspaceRuntimeFromExecutionRunConfig(input);

    expect(result).toEqual({
      cwd: "/tmp/project",
      workspaceStrategy: {
        type: "git_worktree",
      },
    });
    expect(input.workspaceRuntime).toEqual({
      services: [{ name: "web" }],
    });
  });
});

describe("shouldResetTaskSessionForWake", () => {
  it("resets session context on assignment wake", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_assigned" })).toBe(true);
  });

  it("resets session context on execution review wakes", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "execution_review_requested" })).toBe(true);
  });

  it("resets session context on execution approval wakes", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "execution_approval_requested" })).toBe(true);
  });

  it("resets session context on execution changes-requested wakes", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "execution_changes_requested" })).toBe(true);
  });

  it("preserves session context on timer heartbeats", () => {
    expect(shouldResetTaskSessionForWake({ wakeSource: "timer" })).toBe(false);
  });

  it("preserves session context on manual on-demand invokes by default", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
      }),
    ).toBe(false);
  });

  it("resets session context when a fresh session is explicitly requested", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
        forceFreshSession: true,
      }),
    ).toBe(true);
  });

  it("does not reset session context on mention wake comment", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_comment_mentioned",
        wakeCommentId: "comment-1",
      }),
    ).toBe(false);
  });

  it("does not reset session context when commentId is present", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_commented",
        commentId: "comment-2",
      }),
    ).toBe(false);
  });

  it("does not reset for comment wakes", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_commented" })).toBe(false);
  });

  it("does not reset when wake reason is missing", () => {
    expect(shouldResetTaskSessionForWake({})).toBe(false);
  });

  it("does not reset session context on callback on-demand invokes", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "callback",
      }),
    ).toBe(false);
  });

  // HER-707: routine fires continue their session instead of resetting.
  it("does not reset session for routine wakes (routineId present)", () => {
    expect(
      shouldResetTaskSessionForWake({ wakeReason: "issue_assigned", routineId: "routine-1" }),
    ).toBe(false);
  });

  it("still resets when forceFreshSession is requested even for routine wakes", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_assigned",
        routineId: "routine-1",
        forceFreshSession: true,
      }),
    ).toBe(true);
  });
});

describe("deriveTaskKeyWithHeartbeatFallback", () => {
  it("returns explicit taskKey when present", () => {
    expect(deriveTaskKeyWithHeartbeatFallback({ taskKey: "issue-123" }, null)).toBe("issue-123");
  });

  it("returns explicit issueId when no taskKey", () => {
    expect(deriveTaskKeyWithHeartbeatFallback({ issueId: "issue-456" }, null)).toBe("issue-456");
  });

  it("returns __heartbeat__ for timer wakes with no explicit key", () => {
    expect(deriveTaskKeyWithHeartbeatFallback({ wakeSource: "timer" }, null)).toBe("__heartbeat__");
  });

  it("prefers explicit key over heartbeat fallback even on timer wakes", () => {
    expect(
      deriveTaskKeyWithHeartbeatFallback({ wakeSource: "timer", taskKey: "issue-789" }, null),
    ).toBe("issue-789");
  });

  it("returns null for non-timer wakes with no explicit key", () => {
    expect(deriveTaskKeyWithHeartbeatFallback({ wakeSource: "on_demand" }, null)).toBeNull();
  });

  it("returns null for empty context", () => {
    expect(deriveTaskKeyWithHeartbeatFallback({}, null)).toBeNull();
  });
});

describe("deriveSessionTaskKey", () => {
  it("keys routine wakes by routine:<routineId> ahead of the per-fire execution issue id", () => {
    // enrichWakeContextSnapshot stamps the fresh execution issue id into
    // taskKey/taskId/issueId; the routine id must still win so consecutive
    // routine fires share one agent_task_sessions row (HER-707).
    expect(
      deriveSessionTaskKey(
        {
          routineId: "routine-1",
          taskKey: "execution-issue-1",
          taskId: "execution-issue-1",
          issueId: "execution-issue-1",
          wakeSource: "automation",
        },
        null,
      ),
    ).toBe("routine:routine-1");
  });

  it("keeps the routine key stable across different execution issues of the same routine", () => {
    const first = deriveSessionTaskKey({ routineId: "routine-1", issueId: "issue-a" }, null);
    const second = deriveSessionTaskKey({ routineId: "routine-1", issueId: "issue-b" }, null);
    expect(first).toBe("routine:routine-1");
    expect(second).toBe("routine:routine-1");
  });

  it("rejects key-shape spoofing from routine ids containing ':'", () => {
    expect(deriveSessionTaskKey({ routineId: "routine:evil", issueId: "issue-1" }, null)).toBe("issue-1");
  });

  it("falls back to the issue key when no routineId is present", () => {
    expect(deriveSessionTaskKey({ issueId: "issue-1" }, null)).toBe("issue-1");
  });

  it("falls back to __heartbeat__ for timer wakes without routine or issue context", () => {
    expect(deriveSessionTaskKey({ wakeSource: "timer" }, null)).toBe("__heartbeat__");
  });

  // HER-707: different routines assigned to the same agent must get distinct
  // session keys (unique index on company/agent/adapter/task_key).
  it("produces distinct session keys for different routine ids", () => {
    expect(deriveSessionTaskKey({ routineId: "r1" }, null)).toBe("routine:r1");
    expect(deriveSessionTaskKey({ routineId: "r2" }, null)).toBe("routine:r2");
    expect(deriveSessionTaskKey({ routineId: "r1" }, null)).not.toBe(
      deriveSessionTaskKey({ routineId: "r2" }, null),
    );
  });

  it("keys routine id without wakeSource (manual routine runs)", () => {
    expect(deriveSessionTaskKey({ routineId: "routine-1" }, null)).toBe("routine:routine-1");
  });
});

describe("deriveTaskKey (coalescing invariant, HER-707)", () => {
  // The run coalescing key must stay issue-keyed even when routineId is
  // present. If coalescing switched to `routine:<id>`, a second fire while
  // the first run is queued/running would coalesce into the first run and
  // the second execution issue would never get its own run (HER-707
  // success criterion 4). This pins the decoupling between session key
  // (deriveSessionTaskKey) and coalescing key (deriveTaskKey).
  it("returns the per-fire issue id even when routineId is present", () => {
    expect(deriveTaskKey({ issueId: "fire-1", routineId: "r1" }, null)).toBe("fire-1");
  });

  it("still prefers explicit taskKey over issueId", () => {
    expect(deriveTaskKey({ taskKey: "explicit-key", issueId: "fire-1" }, null)).toBe("explicit-key");
  });

  it("returns null for empty context", () => {
    expect(deriveTaskKey({}, null)).toBeNull();
  });
});

describe("comment wake batching", () => {
  it("preserves ordered wake comment ids when coalescing queued follow-up wakes", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        wakeReason: "issue_commented",
        wakeCommentId: "comment-1",
        wakeCommentIds: ["comment-1"],
        paperclipWake: {
          latestCommentId: "comment-1",
        },
      },
      {
        issueId: "issue-1",
        wakeReason: "issue_commented",
        wakeCommentId: "comment-2",
      },
    );

    expect(extractWakeCommentIds(merged)).toEqual(["comment-1", "comment-2"]);
    expect(merged.commentId).toBe("comment-2");
    expect(merged.wakeCommentId).toBe("comment-2");
    expect(merged.paperclipWake).toBeUndefined();
  });
});

describe("buildExplicitResumeSessionOverride", () => {
  it("reuses saved task session params when they belong to the selected failed run", () => {
    const result = buildExplicitResumeSessionOverride({
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "session-before",
      resumeRunSessionIdAfter: "session-after",
      taskSession: {
        sessionParamsJson: {
          sessionId: "session-after",
          cwd: "/tmp/project",
        },
        sessionDisplayId: "session-after",
        lastRunId: "run-1",
      },
      sessionCodec: codexSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "session-after",
      sessionParams: {
        sessionId: "session-after",
        cwd: "/tmp/project",
      },
    });
  });

  it("falls back to the selected run session id when no matching task session params are available", () => {
    const result = buildExplicitResumeSessionOverride({
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "session-before",
      resumeRunSessionIdAfter: "session-after",
      taskSession: {
        sessionParamsJson: {
          sessionId: "other-session",
          cwd: "/tmp/project",
        },
        sessionDisplayId: "other-session",
        lastRunId: "run-2",
      },
      sessionCodec: codexSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "session-after",
      sessionParams: {
        sessionId: "session-after",
      },
    });
  });
});

describe("formatRuntimeWorkspaceWarningLog", () => {
  it("emits informational workspace warnings on stdout", () => {
    expect(formatRuntimeWorkspaceWarningLog("Using fallback workspace")).toEqual({
      stream: "stdout",
      chunk: "[paperclip] Using fallback workspace\n",
    });
  });
});

describe("prioritizeProjectWorkspaceCandidatesForRun", () => {
  it("moves the explicitly selected workspace to the front", () => {
    const rows = [
      { id: "workspace-1", cwd: "/tmp/one" },
      { id: "workspace-2", cwd: "/tmp/two" },
      { id: "workspace-3", cwd: "/tmp/three" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, "workspace-2").map((row) => row.id),
    ).toEqual(["workspace-2", "workspace-1", "workspace-3"]);
  });

  it("keeps the original order when no preferred workspace is selected", () => {
    const rows = [
      { id: "workspace-1" },
      { id: "workspace-2" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, null).map((row) => row.id),
    ).toEqual(["workspace-1", "workspace-2"]);
  });

  it("keeps the original order when the selected workspace is missing", () => {
    const rows = [
      { id: "workspace-1" },
      { id: "workspace-2" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, "workspace-9").map((row) => row.id),
    ).toEqual(["workspace-1", "workspace-2"]);
  });
});

describe("parseSessionCompactionPolicy", () => {
  it("disables Paperclip-managed rotation by default for codex and claude local", () => {
    expect(parseSessionCompactionPolicy(buildAgent("codex_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    });
    expect(parseSessionCompactionPolicy(buildAgent("claude_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    });
  });

  it("keeps conservative defaults for adapters without confirmed native compaction", () => {
    expect(parseSessionCompactionPolicy(buildAgent("cursor"))).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 72,
    });
    expect(parseSessionCompactionPolicy(buildAgent("opencode_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 72,
    });
  });

  it("lets explicit agent overrides win over adapter defaults", () => {
    expect(
      parseSessionCompactionPolicy(
        buildAgent("codex_local", {
          heartbeat: {
            sessionCompaction: {
              maxSessionRuns: 25,
              maxRawInputTokens: 500_000,
            },
          },
        }),
      ),
    ).toEqual({
      enabled: true,
      maxSessionRuns: 25,
      maxRawInputTokens: 500_000,
      maxSessionAgeHours: 0,
    });
  });
});
