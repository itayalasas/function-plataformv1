import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { checkProjectHealth } from "@/lib/api/deployments.functions";
import { cn } from "@/lib/utils";

interface HealthBadgeProps {
  projectId: string;
  /** If false, shows nothing until project has an fqdn. */
  showWhenNotDeployed?: boolean;
  className?: string;
  /** Poll interval in ms. Default 15s. */
  intervalMs?: number;
}

/**
 * Live health indicator that polls the deployed container's runtime-specific health endpoint.
 * Also auto-syncs DB status (deployments/functions) as a side effect.
 */
export function HealthBadge({
  projectId,
  showWhenNotDeployed = false,
  className,
  intervalMs = 15000,
}: HealthBadgeProps) {
  const check = useServerFn(checkProjectHealth);
  const q = useQuery({
    queryKey: ["health", projectId],
    queryFn: () => check({ data: { projectId } }),
    refetchInterval: intervalMs,
    refetchIntervalInBackground: false,
    staleTime: 5000,
  });

  const data = q.data;
  const loading = q.isLoading;
  const status = data?.status ?? (loading ? "checking" : "unknown");

  if (status === "not-deployed" && !showWhenNotDeployed) return null;

  const cfg: Record<string, { dot: string; text: string; label: string }> = {
    operational: { dot: "bg-success", text: "text-success", label: "operational" },
    degraded:    { dot: "bg-amber-500", text: "text-amber-500", label: "degraded" },
    down:        { dot: "bg-destructive", text: "text-destructive", label: "down" },
    "not-deployed": { dot: "bg-muted-foreground/40", text: "text-muted-foreground", label: "sin desplegar" },
    checking:    { dot: "bg-muted-foreground/40 animate-pulse", text: "text-muted-foreground", label: "checking…" },
    unknown:     { dot: "bg-muted-foreground/40", text: "text-muted-foreground", label: "unknown" },
  };
  const c = cfg[status] ?? cfg.unknown;

  const title = data
    ? `HTTP ${data.httpStatus} · ${data.responseTime}ms · ${new Date(data.checkedAt).toLocaleTimeString()}`
    : "Comprobando estado…";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wide border border-border/60 rounded px-1.5 py-0.5",
        c.text,
        className,
      )}
      title={title}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", c.dot)} />
      {c.label}
      {data && data.status !== "not-deployed" && (
        <span className="text-muted-foreground/70 normal-case">· {data.responseTime}ms</span>
      )}
    </span>
  );
}
