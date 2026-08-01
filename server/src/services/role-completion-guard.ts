import { HttpError } from "../errors.js";

export const ROLE_COMPLETION_POLICY_BLOCKED = "ROLE_COMPLETION_POLICY_BLOCKED";

const PLANNING_AGENT_ROLES = new Set([
  "pm",
  "product",
  "product-manager",
  "product_manager",
  "project-manager",
  "project_manager",
  "planner",
]);

const TERMINAL_CHILD_STATUSES = new Set(["done", "cancelled"]);

export interface RoleCompletionIssueRef {
  id: string;
  companyId: string;
  projectId: string | null;
  status: string;
  identifier?: string | null;
}

export interface RoleCompletionAgentRef {
  id: string;
  role: string | null;
}

export interface RoleCompletionProjectRef {
  id: string;
  codebase?: {
    localFolder?: string | null;
    repoUrl?: string | null;
    workspaceId?: string | null;
  } | null;
}

export interface RoleCompletionDocumentRef {
  body?: string | null;
}

export interface RoleCompletionChildIssueRef {
  id: string;
  status: string;
}

export function shouldGuardPlanningRoleCompletion(currentStatus: string, requestedStatus: unknown): boolean {
  return currentStatus !== "done" && requestedStatus === "done";
}

export function isPlanningAgentRole(role: string | null | undefined): boolean {
  if (!role) return false;
  return PLANNING_AGENT_ROLES.has(role.trim().toLowerCase());
}

export function isCodeScopedProject(project: RoleCompletionProjectRef | null): boolean {
  if (!project?.codebase) return false;
  const { localFolder, repoUrl, workspaceId } = project.codebase;
  return Boolean(localFolder || repoUrl || workspaceId);
}

export function hasNonEmptyPlanDocument(document: RoleCompletionDocumentRef | null): boolean {
  return typeof document?.body === "string" && document.body.trim().length > 0;
}

export function hasCompletedDelegatedChildWork(children: RoleCompletionChildIssueRef[]): boolean {
  return children.length > 0 && children.some((child) => child.status === "done")
    && children.every((child) => TERMINAL_CHILD_STATUSES.has(child.status));
}

export class RoleCompletionGuardError extends HttpError {
  constructor(message: string, public readonly code = ROLE_COMPLETION_POLICY_BLOCKED) {
    super(409, message, { code });
  }
}

export async function assertRoleIssueCompletionAllowed(input: {
  issue: RoleCompletionIssueRef;
  requestedStatus: unknown;
  actorAgent: RoleCompletionAgentRef | null;
  getProject: (projectId: string) => Promise<RoleCompletionProjectRef | null>;
  getPlanDocument: (issueId: string) => Promise<RoleCompletionDocumentRef | null>;
  listChildren: (issueId: string) => Promise<RoleCompletionChildIssueRef[]>;
}): Promise<void> {
  if (!shouldGuardPlanningRoleCompletion(input.issue.status, input.requestedStatus)) return;
  if (!isPlanningAgentRole(input.actorAgent?.role)) return;
  if (!input.issue.projectId) return;

  const project = await input.getProject(input.issue.projectId);
  if (!isCodeScopedProject(project)) return;

  const [planDocument, children] = await Promise.all([
    input.getPlanDocument(input.issue.id),
    input.listChildren(input.issue.id),
  ]);

  if (hasNonEmptyPlanDocument(planDocument) && hasCompletedDelegatedChildWork(children)) return;

  throw new RoleCompletionGuardError(
    "Planning-role agents cannot mark code-scoped issues done until they have a non-empty plan document and completed delegated child work.",
  );
}
