import type {
  CerebroLearningCandidateListRequest,
  CerebroLearningCandidateListResponse,
  CerebroLearningCandidateDetailRequest,
  CerebroLearningCandidateDetailResponse,
  CerebroLearningCandidateActionRequest,
  CerebroLearningCandidateActionResponse,
} from "@paperclipai/shared";
import { api } from "./client";

export const cerebroLearningApi = {
  /**
   * List learning candidates for a company.
   */
  list: (companyId: string, params: Partial<Omit<CerebroLearningCandidateListRequest, "companyId">> = {}) =>
    api.get<CerebroLearningCandidateListResponse>(
      `/companies/${companyId}/learning-candidates?${new URLSearchParams({
        ...(params.projectId && { projectId: params.projectId }),
        ...(params.agentId && { agentId: params.agentId }),
        ...(params.runId && { runId: params.runId }),
        ...(params.issueId && { issueId: params.issueId }),
        ...(params.status && { status: params.status }),
        ...(params.limit && { limit: String(params.limit) }),
        ...(params.offset && { offset: String(params.offset) }),
        ...(params.sortBy && { sortBy: params.sortBy }),
        ...(params.sortOrder && { sortOrder: params.sortOrder }),
      }).toString()}`
    ),

  /**
   * Get learning candidate detail.
   */
  get: (companyId: string, candidateId: string) =>
    api.get<CerebroLearningCandidateDetailResponse>(
      `/companies/${companyId}/learning-candidates/${candidateId}`
    ),

  /**
   * Perform action on learning candidate (promote/dismiss/supersede).
   */
  action: (
    companyId: string,
    candidateId: string,
    body: Omit<CerebroLearningCandidateActionRequest, "candidateId" | "companyId">
  ) =>
    api.post<CerebroLearningCandidateActionResponse>(
      `/companies/${companyId}/learning-candidates/${candidateId}/actions`,
      body
    ),
};
