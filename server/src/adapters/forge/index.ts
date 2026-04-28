import type { ServerAdapterModule, AdapterConfigSchema } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

/**
 * Forge adapter configuration schema for UI rendering.
 */
const forgeConfigSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "forgeApiUrl",
      label: "Forge API URL",
      type: "text",
      required: true,
      hint: "Base URL for Forge/Cerebro service (e.g., http://localhost:3000)",
      group: "connection",
    },
    {
      key: "forgeApiToken",
      label: "Forge API Token",
      type: "text",
      required: true,
      hint: "API token for Forge authentication (will be redacted in logs)",
      group: "connection",
    },
    {
      key: "organizationId",
      label: "Organization ID",
      type: "text",
      required: false,
      hint: "Forge organization scope for worker registration",
      group: "scope",
    },
    {
      key: "workspaceId",
      label: "Workspace ID",
      type: "text",
      required: false,
      hint: "Forge workspace scope for worker registration",
      group: "scope",
    },
    {
      key: "projectId",
      label: "Project ID (optional)",
      type: "text",
      required: false,
      hint: "Forge project scope for task filtering",
      group: "scope",
    },
    {
      key: "workerId",
      label: "Worker ID (optional)",
      type: "text",
      required: false,
      hint: "Explicit worker ID for registration (auto-generated if not provided)",
      group: "scope",
    },
    {
      key: "changeId",
      label: "Change ID (fallback)",
      type: "text",
      required: false,
      hint: "Fallback change_id when issue is not linked to a Forge Charter. Prefer linking issues for automatic resolution.",
      group: "target",
    },
  ],
};

/**
 * Agent configuration documentation for the Forge adapter.
 */
const forgeAgentConfigurationDoc = `# Forge agent configuration

Adapter: forge

The Forge adapter delegates Paperclip agent execution to a Forge Charter via HTTP API.
It enables Paperclip to participate in Forge-managed spec workflows while maintaining
the Paperclip ↔ Forge authority boundary.

Core fields:
- forgeApiUrl (string, required): Base URL for Forge/Cerebro service
- forgeApiToken (string, required): API token for Forge authentication

Scope fields (optional but recommended):
- organizationId (string): Forge organization scope
- workspaceId (string): Forge workspace scope
- projectId (string): Forge project scope for task filtering
- workerId (string): Explicit worker ID (auto-generated if not provided)

Target fields:
- changeId (string, optional): Fallback change_id when issue is not linked to a Forge Charter.
  Prefer linking issues (originKind="forge_charter") for automatic change_id resolution.

Authority model:
- Paperclip owns: agents, issues, runs, budgets, adapter execution records
- Forge owns: Charter lifecycle, task leases, completion/failure, evidence, eval readiness
- This adapter is a bridge: it mirrors and delegates, but does not certify completion

HTTP boundary:
- Uses /api/spec/changes/{change_id} for status checks
- Uses /api/spec/workers/register for worker registration
- Uses /api/spec/tasks/claim for task claiming
- Uses /api/spec/evidence for execution evidence
- Never reads or writes Forge DB/filesystem artifacts

Security:
- Tokens are redacted from all logs, errors, and metadata
- Fail-closed behavior on missing config or connectivity issues
`;

/**
 * Forge built-in adapter module.
 *
 * Provides native Paperclip integration with Forge Charters over HTTP only.
 * This adapter delegates execution to Forge without accessing Forge's DB or filesystem.
 */
export const forgeAdapter: ServerAdapterModule = {
  type: "forge",
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc: forgeAgentConfigurationDoc,
  getConfigSchema: () => forgeConfigSchema,
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
};
