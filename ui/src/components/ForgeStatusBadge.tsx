import { useQuery } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { issuesApi, type ForgeLinkStatus } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Hexagon, AlertCircle, Loader2 } from "lucide-react";

interface ForgeStatusBadgeProps {
  issue: Issue;
  className?: string;
  showLabel?: boolean;
  size?: "sm" | "md";
}

const forgeStatusColors: Record<string, string> = {
  draft: "bg-neutral-500/10 text-neutral-600 border-neutral-500/30 dark:text-neutral-400",
  pending: "bg-yellow-500/10 text-yellow-600 border-yellow-500/30 dark:text-yellow-400",
  in_progress: "bg-blue-500/10 text-blue-600 border-blue-500/30 dark:text-blue-400",
  in_review: "bg-violet-500/10 text-violet-600 border-violet-500/30 dark:text-violet-400",
  verified: "bg-green-500/10 text-green-600 border-green-500/30 dark:text-green-400",
  completed: "bg-green-500/10 text-green-600 border-green-500/30 dark:text-green-400",
  archived: "bg-muted-foreground/10 text-muted-foreground border-muted-foreground/30",
  rejected: "bg-red-500/10 text-red-600 border-red-500/30 dark:text-red-400",
};

const defaultStatusColor = "bg-neutral-500/10 text-neutral-600 border-neutral-500/30 dark:text-neutral-400";

function isForgeLinkedIssue(issue: Issue): boolean {
  return issue.originKind === "forge_charter" && !!issue.originId;
}

function formatForgeStatus(status: string | null): string {
  if (!status) return "Forge";
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function useForgeLinkStatus(issue: Issue) {
  const enabled = isForgeLinkedIssue(issue);

  return useQuery<ForgeLinkStatus, Error>({
    queryKey: queryKeys.issues.forgeLink(issue.id),
    queryFn: () => issuesApi.getForgeLink(issue.id),
    enabled,
    staleTime: 30000,
    retry: (failureCount, error) => {
      if (error instanceof Error && "status" in error) {
        const status = (error as { status: number }).status;
        if (status === 404 || status === 403) return false;
      }
      return failureCount < 2;
    },
  });
}

export function ForgeStatusBadge({
  issue,
  className,
  showLabel = true,
  size = "sm",
}: ForgeStatusBadgeProps) {
  const { data, isLoading, error } = useForgeLinkStatus(issue);

  if (!isForgeLinkedIssue(issue)) {
    return null;
  }

  const sizeClasses = size === "sm"
    ? "text-[10px] px-1.5 py-0.5 gap-1"
    : "text-xs px-2 py-1 gap-1.5";

  const iconSize = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";

  if (isLoading) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full border font-medium",
          sizeClasses,
          "bg-muted/50 text-muted-foreground border-muted",
          className
        )}
        title="Loading Forge status..."
      >
        <Loader2 className={cn(iconSize, "animate-spin")} />
        {showLabel && <span>Forge</span>}
      </span>
    );
  }

  if (error || data?.error || !data?.linkActive) {
    const errorTitle = data?.error || (error instanceof Error ? error.message : "Forge status unavailable");
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full border font-medium",
          sizeClasses,
          "bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400",
          className
        )}
        title={errorTitle}
      >
        <AlertCircle className={iconSize} />
        {showLabel && <span>Forge</span>}
      </span>
    );
  }

  const status = data.forgeStatus ?? "linked";
  const colorClass = forgeStatusColors[status] ?? defaultStatusColor;
  const displayStatus = formatForgeStatus(status);
  const titleText = `Forge Charter: ${data.changeId}${data.forgeStatus ? ` · ${displayStatus}` : ""}`;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border font-medium",
        sizeClasses,
        colorClass,
        className
      )}
      title={titleText}
    >
      <Hexagon className={iconSize} />
      {showLabel && (
        <span className="truncate max-w-[120px]">
          {data.changeId.slice(0, 8)}
          {data.forgeStatus && ` · ${displayStatus}`}
        </span>
      )}
    </span>
  );
}

export function ForgeStatusBadgeCompact({
  issue,
  className,
}: {
  issue: Issue;
  className?: string;
}) {
  const { data, isLoading, error } = useForgeLinkStatus(issue);

  if (!isForgeLinkedIssue(issue)) {
    return null;
  }

  if (isLoading) {
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-full bg-muted/50",
          "h-4 w-4",
          className
        )}
        title="Loading Forge status..."
      >
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
      </span>
    );
  }

  if (error || data?.error || !data?.linkActive) {
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-full",
          "h-4 w-4 bg-amber-500/20",
          className
        )}
        title={data?.error || "Forge status unavailable"}
      >
        <AlertCircle className="h-3 w-3 text-amber-600 dark:text-amber-400" />
      </span>
    );
  }

  const status = data.forgeStatus ?? "linked";
  const colorClass = forgeStatusColors[status] ?? defaultStatusColor;
  const displayStatus = formatForgeStatus(status);
  const titleText = `Forge: ${data.changeId}${data.forgeStatus ? ` · ${displayStatus}` : ""}`;

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full",
        "h-4 w-4",
        colorClass.split(" ")[0],
        className
      )}
      title={titleText}
    >
      <Hexagon className="h-3 w-3" />
    </span>
  );
}
