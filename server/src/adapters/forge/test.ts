import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { parseObject, asString } from "../utils.js";
import { redactSensitiveValues, normalizeForgeUrl, redactHeadersForLogging } from "./utils.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export interface ForgeAdapterConfig {
  forgeApiUrl?: string;
  forgeApiToken?: string;
  organizationId?: string;
  workspaceId?: string;
  projectId?: string;
  workerId?: string;
  changeId?: string;
}

/**
 * Test the Forge adapter environment configuration.
 * Fail-closed: any missing or invalid config results in error status.
 */
export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config) as ForgeAdapterConfig;

  // Validate forgeApiUrl
  const urlValue = asString(config.forgeApiUrl, "");
  if (!urlValue) {
    checks.push({
      code: "forge_url_missing",
      level: "error",
      message: "Forge adapter requires forgeApiUrl.",
      hint: "Set adapterConfig.forgeApiUrl to the Forge/Cerebro base URL (e.g., http://localhost:3000).",
    });
  } else {
    const normalizedUrl = normalizeForgeUrl(urlValue);
    if (!normalizedUrl) {
      checks.push({
        code: "forge_url_invalid",
        level: "error",
        message: `Invalid Forge API URL: ${urlValue}`,
        hint: "Use a valid http:// or https:// URL.",
      });
    } else {
      checks.push({
        code: "forge_url_valid",
        level: "info",
        message: `Configured Forge URL: ${normalizedUrl.toString()}`,
      });
    }
  }

  // Validate forgeApiToken
  const tokenValue = asString(config.forgeApiToken, "");
  if (!tokenValue) {
    checks.push({
      code: "forge_token_missing",
      level: "error",
      message: "Forge adapter requires forgeApiToken.",
      hint: "Set adapterConfig.forgeApiToken to a valid Forge API token.",
    });
  } else {
    checks.push({
      code: "forge_token_configured",
      level: "info",
      message: "Forge API token is configured.",
    });
  }

  // Validate organizationId (required for scope)
  const orgId = asString(config.organizationId, "");
  if (!orgId) {
    checks.push({
      code: "forge_org_missing",
      level: "warn",
      message: "organizationId is not configured.",
      hint: "Set adapterConfig.organizationId for proper scope resolution.",
    });
  } else {
    checks.push({
      code: "forge_org_configured",
      level: "info",
      message: `Configured organization: ${orgId}`,
    });
  }

  // Validate workspaceId (required for scope)
  const workspaceId = asString(config.workspaceId, "");
  if (!workspaceId) {
    checks.push({
      code: "forge_workspace_missing",
      level: "warn",
      message: "workspaceId is not configured.",
      hint: "Set adapterConfig.workspaceId for proper scope resolution.",
    });
  } else {
    checks.push({
      code: "forge_workspace_configured",
      level: "info",
      message: `Configured workspace: ${workspaceId}`,
    });
  }

  // Optional: changeId (fallback when no linked issue)
  const changeId = asString(config.changeId, "");
  if (changeId) {
    checks.push({
      code: "forge_changeid_configured",
      level: "info",
      message: `Configured fallback changeId: ${changeId}`,
    });
  } else {
    checks.push({
      code: "forge_changeid_not_configured",
      level: "info",
      message: "No fallback changeId configured. Will require linked issue context.",
    });
  }

  // If we have URL and token, try to probe the Forge status endpoint
  const normalizedUrl = normalizeForgeUrl(urlValue);
  if (normalizedUrl && tokenValue) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const probeUrl = `${normalizedUrl.toString()}/api/spec/status`;
      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (tokenValue) {
        headers.Authorization = `Bearer ${tokenValue}`;
      }

      const response = await fetch(probeUrl, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (response.ok) {
        checks.push({
          code: "forge_connectivity_ok",
          level: "info",
          message: "Successfully connected to Forge API.",
        });
      } else if (response.status === 404) {
        // 404 is expected if /api/spec/status doesn't exist, but server is reachable
        checks.push({
          code: "forge_connectivity_reachable",
          level: "info",
          message: "Forge API host is reachable (status endpoint returned 404, which is acceptable).",
        });
      } else {
        // Non-2xx, non-404 response - fail closed
        const redactedStatus = redactSensitiveValues(`HTTP ${response.status}`);
        checks.push({
          code: "forge_connectivity_unexpected",
          level: "error",
          message: `Forge API returned ${redactedStatus}.`,
          hint: "Verify the Forge API token and URL are correct.",
        });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      const redactedError = redactSensitiveValues(errorMessage);
      checks.push({
        code: "forge_connectivity_failed",
        level: "error",
        message: `Could not connect to Forge API: ${redactedError}`,
        hint: "Verify network connectivity and Forge API URL.",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
