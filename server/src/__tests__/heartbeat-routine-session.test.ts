import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  activityLog,
  companies,
  companySkills,
  costEvents,
  createDb,
  financeEvents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged routine execution.",
    sessionParams: { sessionId: "routine-session-1" },
    // Report a cost so usageJson (which carries the session-reuse markers) is
    // persisted on the run row.
    costUsd: 0.01,
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { runningProcesses } from "../adapters/index.ts";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine session tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat routine-execution session keys", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-routine-session-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // All seeded rows trace back to companies (agents, projects, issues,
    // comments, runs, cost/finance events, document revisions, ...). A single
    // cascading truncate keeps cleanup FK-safe without enumerating every
    // referencing table in dependency order.
    await db.execute(sql`truncate table companies cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keys routine-execution sessions by routine:<routineId> so consecutive fires share one row and resume", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const routineId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RoutineRunner",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });

    // Routine dispatch creates a fresh execution issue per fire
    // (issues.origin_kind = 'routine_execution', origin_id = routine id).
    const fireIssueIds: string[] = [];
    for (let fire = 1; fire <= 2; fire += 1) {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Routine execution fire ${fire}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: fire,
        identifier: `${issuePrefix}-${fire}`,
        originKind: "routine_execution",
        originId: routineId,
        originFingerprint: `fire-${fire}`,
      });
      fireIssueIds.push(issueId);
    }

    const heartbeat = heartbeatService(db);

    // Fire 1: no prior session; the run must create the routine-keyed session row.
    const firstRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: fireIssueIds[0]!, mutation: "create" },
      contextSnapshot: { issueId: fireIssueIds[0]!, source: "routine.dispatch" },
    });
    expect(firstRun).not.toBeNull();
    const firstFinished = await waitForRunToFinish(heartbeat, firstRun!.id);
    expect(firstFinished?.status).toBe("succeeded");
    expect(firstFinished?.sessionIdAfter).toBe("routine-session-1");

    // Fire 2: same routine, fresh execution issue. It must reuse the same
    // agent_task_sessions row (task_key = routine:<routineId>) and resume the
    // prior session (sessionIdBefore set, no second session row).
    const secondRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: fireIssueIds[1]!, mutation: "create" },
      contextSnapshot: { issueId: fireIssueIds[1]!, source: "routine.dispatch" },
    });
    expect(secondRun).not.toBeNull();
    const secondFinished = await waitForRunToFinish(heartbeat, secondRun!.id);
    expect(secondFinished?.status).toBe("succeeded");
    expect(secondFinished?.sessionIdBefore).toBe("routine-session-1");

    const sessionRows = await db
      .select()
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, companyId),
          eq(agentTaskSessions.agentId, agentId),
        ),
      );
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.taskKey).toBe(`routine:${routineId}`);

    // Each fire must still have produced its own execution issue (criterion 4).
    const executionIssues = await db
      .select({ id: issues.id, originId: issues.originId })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "routine_execution")));
    expect(executionIssues).toHaveLength(2);
    expect(executionIssues.map((row) => row.originId)).toEqual([routineId, routineId]);

    // ...and its own heartbeat run (audit preserved; coalescing stays per-issue).
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((row) => row.id)).size).toBe(2);

    // The second run's usage marks the session as reused rather than fresh.
    const usage = secondFinished?.usageJson as Record<string, unknown> | null;
    expect(usage?.taskSessionReused).toBe(true);
    expect(usage?.sessionReused).toBe(true);
  });
});

describe("queueIssueAssignmentWakeup routine dispatch propagation", () => {
  const wakeup = vi.fn(async (_agentId: string, _opts: Record<string, unknown>) => null);

  beforeEach(() => {
    wakeup.mockClear();
  });

  it("carries routineId into the wake contextSnapshot for routine dispatch", async () => {
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "execution-issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "routine.dispatch",
      routineId: "routine-1",
      rethrowOnError: true,
    });

    expect(wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({ source: "assignment" }));
    const wakeupOpts = wakeup.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(wakeupOpts.contextSnapshot).toMatchObject({
      issueId: "execution-issue-1",
      source: "routine.dispatch",
      routineId: "routine-1",
    });
  });

  it("omits routineId from the wake context for ordinary issue assignment wakes", async () => {
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.assignment",
      rethrowOnError: true,
    });

    const wakeupOpts = wakeup.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(wakeupOpts.contextSnapshot).toMatchObject({ issueId: "issue-1", source: "issue.assignment" });
    expect(wakeupOpts.contextSnapshot).not.toHaveProperty("routineId");
  });
});
