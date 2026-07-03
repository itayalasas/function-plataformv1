import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Download,
  FileCode,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { checkProjectHealth } from "@/lib/api/deployments.functions";
import { listFunctions } from "@/lib/api/functions.functions";
import { cn } from "@/lib/utils";

type DashboardProject = {
  id: string;
  name: string;
  slug: string;
  runtime: string;
  created_at: string;
};

type DashboardFunction = {
  id: string;
  name: string;
  slug: string;
  status: string;
  fqdn: string | null;
  created_at: string;
  updated_at: string;
  entrypoint: string;
  current_deployment_id: string | null;
};

type ProjectHealth = {
  status: "operational" | "degraded" | "down" | "not-deployed";
  httpStatus: number;
  responseTime: number;
  body: string | null;
  fqdn: string | null;
  checkedAt: string;
};

interface DashboardOverviewProps {
  projects: DashboardProject[];
  loading?: boolean;
  onOpenProject: (projectId: string) => void;
  onInstallCli: () => void;
  installingCli?: boolean;
}

type HealthStatus = ProjectHealth["status"] | "checking" | "unknown";

export function DashboardOverview({
  projects,
  loading = false,
  onOpenProject,
  onInstallCli,
  installingCli = false,
}: DashboardOverviewProps) {
  const qc = useQueryClient();
  const loadFunctions = useServerFn(listFunctions);
  const checkHealth = useServerFn(checkProjectHealth);

  const functionQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: ["dashboard", "functions", project.id],
      queryFn: () => loadFunctions({ data: { projectId: project.id } }),
      staleTime: 20_000,
      refetchInterval: 30_000,
    })),
  });

  const healthQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: ["dashboard", "health", project.id],
      queryFn: () => checkHealth({ data: { projectId: project.id } }),
      staleTime: 5_000,
      refetchInterval: 15_000,
    })),
  });

  const cards = projects.map((project, index) => {
    const functions = (functionQueries[index]?.data ?? []) as DashboardFunction[];
    const health = healthQueries[index]?.data as ProjectHealth | undefined;
    const status: HealthStatus = health?.status ?? (healthQueries[index]?.isLoading ? "checking" : "unknown");
    const liveFunctions = functions.filter((fn) => fn.status === "live").length;

    return {
      project,
      functions,
      health,
      status,
      liveFunctions,
    };
  });

  const totalFunctions = cards.reduce((sum, card) => sum + card.functions.length, 0);
  const liveProjects = cards.filter((card) => card.status === "operational" || card.status === "degraded").length;
  const liveFunctions = cards.reduce((sum, card) => sum + card.liveFunctions, 0);
  const pendingFunctions = totalFunctions - liveFunctions;

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["projects"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  if (loading && projects.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Cargando dashboard...
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-background">
      <div className="relative border-b border-border/60 bg-gradient-to-br from-primary/10 via-transparent to-cyan-500/10">
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.16),transparent_32%),radial-gradient(circle_at_20%_0%,rgba(14,165,233,0.14),transparent_28%)]" />
        <div className="relative px-6 pt-6 pb-5">
          <div className="flex items-start justify-between gap-4">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-mono uppercase tracking-[0.18em] text-primary">
                <Sparkles className="w-3 h-3" /> Health check
              </div>
              <h1 className="mt-4 font-display text-3xl md:text-4xl font-semibold tracking-tight">
                Dashboard
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                Vista general de tus proyectos, sus container apps y el estado de cada funcion.
                Usa la barra lateral para entrar al editor de un proyecto cuando quieras.
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={onInstallCli}
                disabled={installingCli}
                title="Descarga un instalador para el CLI local"
              >
                {installingCli ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                Instalar CLI
              </Button>
              <Button variant="outline" size="sm" className="gap-2" onClick={refreshAll}>
                <RefreshCw className="w-3.5 h-3.5" />
                Actualizar
              </Button>
            </div>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              icon={<Activity className="w-4 h-4" />}
              label="Proyectos"
              value={projects.length}
              hint="listados en la barra lateral"
            />
            <StatCard
              icon={<CheckCircle2 className="w-4 h-4" />}
              label="Container apps vivas"
              value={liveProjects}
              hint={`${projects.length - liveProjects} necesitan atencion`}
              tone="good"
            />
            <StatCard
              icon={<CheckCircle2 className="w-4 h-4" />}
              label="Funciones live"
              value={liveFunctions}
              hint={`${pendingFunctions} pendientes de deploy`}
              tone="good"
            />
            <StatCard
              icon={<FileCode className="w-4 h-4" />}
              label="Funciones totales"
              value={totalFunctions}
              hint={`${projects.length} proyectos monitoreados`}
            />
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-6">
          {projects.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/70 bg-card/40 px-6 py-10 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/25 bg-primary/10 text-primary">
                <Sparkles className="h-5 w-5" />
              </div>
              <h2 className="font-display text-xl font-semibold">Todavia no hay proyectos</h2>
              <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
                Crea tu primer proyecto desde el boton + de la barra lateral. Aqui vas a ver su
                health check, su container app y sus funciones en cuanto exista.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
              {cards.map(({ project, functions, health, status, liveFunctions: projectLiveFunctions }) => (
                <article
                  key={project.id}
                  className={cn(
                    "rounded-2xl border bg-card/60 p-4 shadow-sm backdrop-blur-sm transition-colors",
                    projectCardTone(status),
                  )}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <h2 className="truncate font-display text-lg font-semibold">{project.name}</h2>
                        <Badge variant="outline" className="h-5 rounded-md px-1.5 text-[10px] font-mono uppercase">
                          {project.runtime}
                        </Badge>
                      </div>
                      <div
                        className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                        title={health?.fqdn ? `https://${health.fqdn}` : project.slug}
                      >
                        {health?.fqdn ? `https://${health.fqdn}` : `/${project.slug}`}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <HealthPill status={status} responseTime={health?.responseTime} />
                      <Button size="sm" variant="outline" className="gap-1" onClick={() => onOpenProject(project.id)}>
                        Abrir <ArrowRight className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>{functions.length} funciones</span>
                    <span>{projectLiveFunctions} live</span>
                    <span>health check cada 15s</span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {functions.slice(0, 4).map((fn) => (
                      <FunctionChip key={fn.id} name={fn.name} status={fn.status} title={fn.entrypoint} />
                    ))}
                    {functions.length > 4 && (
                      <span className="inline-flex items-center rounded-full border border-border bg-background/50 px-2 py-1 text-[10px] font-mono text-muted-foreground">
                        +{functions.length - 4} mas
                      </span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
  tone = "neutral",
}: {
  icon: ReactNode;
  label: string;
  value: number | string;
  hint: string;
  tone?: "neutral" | "good";
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border p-4 shadow-sm backdrop-blur-sm",
        tone === "good" ? "border-success/20 bg-success/5" : "border-border/70 bg-card/60",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground font-mono">
            {label}
          </div>
          <div className="mt-2 text-3xl font-display font-semibold">{value}</div>
          <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
        </div>
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-xl border",
            tone === "good"
              ? "border-success/20 bg-success/10 text-success"
              : "border-border bg-background/70 text-muted-foreground",
          )}
        >
          {icon}
        </div>
      </div>
    </div>
  );
}

function HealthPill({ status, responseTime }: { status: HealthStatus; responseTime?: number }) {
  const meta = healthMeta(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-mono uppercase tracking-wide",
        meta.className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.dotClass)} />
      {meta.label}
      {typeof responseTime === "number" && status !== "not-deployed" && status !== "unknown" && status !== "checking" && (
        <span className="normal-case text-muted-foreground/70">{responseTime}ms</span>
      )}
    </span>
  );
}

function FunctionChip({ name, status, title }: { name: string; status: string; title?: string }) {
  const meta = functionMeta(status);
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-mono uppercase tracking-wide",
        meta.className,
      )}
      title={title}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.dotClass)} />
      <span className="truncate">{name}</span>
      <span className="normal-case opacity-80">{meta.label}</span>
    </span>
  );
}

function healthMeta(status: HealthStatus) {
  switch (status) {
    case "operational":
      return {
        label: "viva",
        className: "border-success/30 bg-success/10 text-success",
        dotClass: "bg-success",
      };
    case "degraded":
      return {
        label: "degradada",
        className: "border-amber-500/30 bg-amber-500/10 text-amber-500",
        dotClass: "bg-amber-500",
      };
    case "down":
      return {
        label: "caida",
        className: "border-destructive/30 bg-destructive/10 text-destructive",
        dotClass: "bg-destructive",
      };
    case "not-deployed":
      return {
        label: "sin deploy",
        className: "border-border bg-background/70 text-muted-foreground",
        dotClass: "bg-muted-foreground/50",
      };
    case "checking":
      return {
        label: "verificando",
        className: "border-border bg-background/70 text-muted-foreground",
        dotClass: "bg-muted-foreground/50 animate-pulse",
      };
    default:
      return {
        label: "desconocido",
        className: "border-border bg-background/70 text-muted-foreground",
        dotClass: "bg-muted-foreground/50",
      };
  }
}

function functionMeta(status: string) {
  switch (status) {
    case "live":
      return {
        label: "live",
        className: "border-success/20 bg-success/10 text-success",
        dotClass: "bg-success",
      };
    case "modified":
      return {
        label: "modified",
        className: "border-amber-500/20 bg-amber-500/10 text-amber-500",
        dotClass: "bg-amber-500",
      };
    case "draft":
      return {
        label: "draft",
        className: "border-border bg-background/70 text-muted-foreground",
        dotClass: "bg-muted-foreground/50",
      };
    default:
      return {
        label: status || "unknown",
        className: "border-border bg-background/70 text-muted-foreground",
        dotClass: "bg-muted-foreground/50",
      };
  }
}

function projectCardTone(status: HealthStatus) {
  switch (status) {
    case "operational":
      return "border-success/20";
    case "degraded":
      return "border-amber-500/20";
    case "down":
      return "border-destructive/20";
    default:
      return "border-border/70";
  }
}
