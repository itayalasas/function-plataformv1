import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Zap, Plus, Trash2, Rocket, FileCode, Lock, Activity,
  Play, Loader2, LogOut, FolderOpen, RefreshCw, ExternalLink, Eye, EyeOff,
  CheckCircle2, XCircle, Sparkles, Wand2, Copy, Globe, ArrowLeft, Pencil, FolderPlus,
  Download,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MonacoCodeEditor } from "@/components/MonacoCodeEditor";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

import { useAuth } from "@/hooks/use-auth";
import { getAccessToken } from "@/lib/auth/auth-system";
import {
  listProjects,
  createProject,
  deleteProject,
  getProjectContainerAppStatus,
  startProjectContainerApp,
  stopProjectContainerApp,
  restartProjectContainerApp,
} from "@/lib/api/projects.functions";
import { listFunctions, createFunction, deleteFunction } from "@/lib/api/functions.functions";
import { listFiles, upsertFile, createDirectory, deleteFile, renameFile } from "@/lib/api/files.functions";
import { FileTree } from "@/components/FileTree";
import { listSecrets, upsertSecret, deleteSecret } from "@/lib/api/secrets.functions";
import { listTokens, upsertToken, deleteToken } from "@/lib/api/tokens.functions";
import { listDeployments, deployProject } from "@/lib/api/deployments.functions";
import { HealthBadge } from "@/components/HealthBadge";
import { DashboardOverview } from "@/components/DashboardOverview";
import { invokeFunction } from "@/lib/api/invoke.functions";
import { validateFunction } from "@/lib/api/validate.functions";
import { aiAssist } from "@/lib/api/ai.functions";
import { listSystemLogs, clearSystemLogs } from "@/lib/api/system-logs.functions";
import { VortexLogo } from "@/components/VortexLogo";
import { getRuntimeConfig } from "@/lib/runtimes";



export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

function normalizeValidationText(input: string): string {
  return input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;

  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const fallbackMatch = header.match(/filename="?([^"]+)"?/i);
  return fallbackMatch?.[1] ?? null;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function containerAppStatusMeta(status: string | null | undefined) {
  const normalized = (status ?? "unknown").toLowerCase();
  switch (normalized) {
    case "running":
      return {
        label: "viva",
        className: "border-success/30 bg-success/10 text-success",
        dotClass: "bg-success",
      };
    case "stopped":
      return {
        label: "parada",
        className: "border-destructive/30 bg-destructive/10 text-destructive",
        dotClass: "bg-destructive",
      };
    case "progressing":
      return {
        label: "arrancando",
        className: "border-amber-500/30 bg-amber-500/10 text-amber-500",
        dotClass: "bg-amber-500 animate-pulse",
      };
    case "not deployed":
    case "missing":
      return {
        label: "sin deploy",
        className: "border-border bg-background/70 text-muted-foreground",
        dotClass: "bg-muted-foreground/50",
      };
    default:
      return {
        label: status ?? "desconocido",
        className: "border-border bg-background/70 text-muted-foreground",
        dotClass: "bg-muted-foreground/50",
      };
  }
}

function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [projectId, setProjectId] = useState<string | null>(null);
  const [functionId, setFunctionId] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<string>("index.ts");
  const [installingCli, setInstallingCli] = useState(false);

  const lp = useServerFn(listProjects);
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: async ({ signal }) => {
      const projectsAbort = new AbortController();
      const timeout = window.setTimeout(() => projectsAbort.abort(), 12_000);
      signal.addEventListener("abort", () => projectsAbort.abort(), { once: true });
      try {
        return (await lp({ signal: projectsAbort.signal } as never)) ?? [];
      } finally {
        window.clearTimeout(timeout);
      }
    },
    retry: 3,
    retryDelay: (attempt) => Math.min(800 * 2 ** attempt, 3_000),
    staleTime: 5_000,
  });

  const currentProject = projects.data?.find((p) => p.id === projectId) ?? null;

  const downloadCliInstaller = async () => {
    if (installingCli) return;

    const token = getAccessToken();
    if (!token) {
      toast.error("No se encontró el token de sesión. Vuelve a iniciar sesión.");
      return;
    }

    setInstallingCli(true);
    try {
      const res = await fetch("/api/cli/installer", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        const text = await res.text();
        let message = text || `Error ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { error?: string; message?: string };
          message = parsed.error ?? parsed.message ?? message;
        } catch {
          // keep raw response text
        }
        throw new Error(message);
      }

      const blob = await res.blob();
      const filename =
        filenameFromContentDisposition(res.headers.get("content-disposition")) ??
        "vortex-install.mjs";
      triggerDownload(blob, filename);
      toast.success("Instalador descargado");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo descargar el instalador");
    } finally {
      setInstallingCli(false);
    }
  };

  return (
    <div className="h-screen overflow-hidden bg-background flex">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-sidebar flex flex-col">
        <div className="h-14 border-b border-border px-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => { setProjectId(null); setFunctionId(null); setActiveFile("index.ts"); }}
            className="flex items-center gap-2 min-w-0"
            title="Volver al dashboard"
          >
            <VortexLogo size={28} />
            <span className="font-display font-bold text-gradient">Vortex</span>
          </button>
          <Badge variant="outline" className="ml-auto text-[10px] font-mono px-1.5 py-0">ACA</Badge>
        </div>

        <div className="p-3 flex items-center justify-between">
          <span className="text-xs font-mono uppercase text-muted-foreground">Proyectos</span>
          <NewProjectDialog onCreated={(id) => { setProjectId(id); setFunctionId(null); }} />
        </div>
        <ScrollArea className="flex-1">
          <div className="px-2 space-y-0.5">
            {projects.isLoading && <div className="text-xs text-muted-foreground px-2 py-1">Cargando…</div>}
            {projects.isError && (
              <div className="px-2 py-2 space-y-2">
                <div className="text-xs text-destructive">No se pudieron cargar los proyectos.</div>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => projects.refetch()}>
                  <RefreshCw className="w-3 h-3" /> Reintentar
                </Button>
              </div>
            )}
            {projects.data?.length === 0 && (
              <div className="text-xs text-muted-foreground px-2 py-3">Crea tu primer proyecto.</div>
            )}
            {projects.data?.map((p) => (
              <button
                key={p.id}
                onClick={() => { setProjectId(p.id); setFunctionId(null); }}
                className={`w-full text-left px-3 py-2 rounded-md text-sm flex items-center gap-2 transition-colors ${
                  projectId === p.id ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/50"
                }`}
              >
                <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate flex-1">{p.name}</span>
                <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 font-mono uppercase">
                  {(p as { runtime?: string }).runtime ?? "deno"}
                </Badge>
              </button>
            ))}
          </div>
        </ScrollArea>

        <div className="border-t border-border p-3 flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center text-xs font-mono">
            {user?.email?.[0]?.toUpperCase() ?? "U"}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs truncate">{user?.email}</div>
          </div>
          <Button size="icon" variant="ghost" onClick={async () => { await signOut(); navigate({ to: "/login" }); }}>
            <LogOut className="w-4 h-4" />
          </Button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        {projectId ? (
          <ProjectView
            projectId={projectId}
            projectSlug={currentProject?.slug ?? "project"}
            projectRuntime={currentProject?.runtime ?? "deno"}
            functionId={functionId}
            setFunctionId={(id) => { setFunctionId(id); setActiveFile("index.ts"); }}
            activeFile={activeFile}
            setActiveFile={setActiveFile}
            onInstallCli={downloadCliInstaller}
            installingCli={installingCli}
            onProjectDeleted={() => {
              setProjectId(null);
              setFunctionId(null);
              setActiveFile("index.ts");
              qc.invalidateQueries({ queryKey: ["projects"] });
              qc.invalidateQueries({ queryKey: ["dashboard"] });
            }}
          />
        ) : (
          <DashboardOverview
            projects={projects.data ?? []}
            loading={projects.isLoading}
            onOpenProject={(id) => {
              setProjectId(id);
              setFunctionId(null);
              setActiveFile("index.ts");
            }}
            onInstallCli={downloadCliInstaller}
            installingCli={installingCli}
          />
        )}
      </main>
    </div>
  );
}

function NewProjectDialog({ onCreated }: { onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [runtime, setRuntime] = useState<"deno" | "node" | "python" | "java" | "dotnet">("deno");
  const qc = useQueryClient();
  const cp = useServerFn(createProject);
  const mut = useMutation({
    mutationFn: (args: { name: string; runtime: typeof runtime }) => cp({ data: args }),
    onSuccess: (p) => {
      toast.success("Proyecto creado");
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      onCreated(p.id);
      setOpen(false); setName(""); setRuntime("deno");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error"),
  });

  const runtimeOptions: Array<{ id: typeof runtime; label: string; desc: string }> = [
    { id: "deno", label: "Deno", desc: "TS/JS · hot-reload sin redeploy" },
    { id: "node", label: "Node.js 20", desc: "JavaScript · redeploy al cambiar código" },
    { id: "python", label: "Python 3.12", desc: "Python · redeploy al cambiar código" },
    { id: "java", label: "Java 21 / Spring Boot", desc: "Build de Maven en boot (~1-3 min)" },
    { id: "dotnet", label: ".NET 8 ASP.NET Core", desc: "dotnet publish en boot (~1-2 min)" },
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" className="h-7 w-7"><Plus className="w-4 h-4" /></Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Nuevo proyecto</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="pname">Nombre</Label>
            <Input id="pname" value={name} onChange={(e) => setName(e.target.value)} placeholder="Mi proyecto" />
          </div>
          <div className="space-y-2">
            <Label>Runtime</Label>
            <div className="grid gap-1.5">
              {runtimeOptions.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setRuntime(opt.id)}
                  className={`text-left px-3 py-2 rounded-md border text-sm transition-colors ${
                    runtime === opt.id
                      ? "border-primary bg-primary/10"
                      : "border-border hover:bg-muted"
                  }`}
                >
                  <div className="font-medium">{opt.label}</div>
                  <div className="text-xs text-muted-foreground">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button disabled={!name || mut.isPending} onClick={() => mut.mutate({ name, runtime })}>
            {mut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Crear"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProjectView({
  projectId, projectSlug, projectRuntime, functionId, setFunctionId, activeFile, setActiveFile, onInstallCli, installingCli, onProjectDeleted,
}: {
  projectId: string;
  projectSlug: string;
  projectRuntime: string;
  functionId: string | null;
  setFunctionId: (id: string | null) => void;
  activeFile: string;
  setActiveFile: (p: string) => void;
  onInstallCli: () => void;
  installingCli: boolean;
  onProjectDeleted: () => void;
}) {
  const qc = useQueryClient();
  const lf = useServerFn(listFunctions);
  const cf = useServerFn(createFunction);
  const df = useServerFn(deleteFunction);
  const dp = useServerFn(deleteProject);
  const runtime = getRuntimeConfig(projectRuntime);
  const [exporting, setExporting] = useState(false);
  const loadProjectAppStatus = useServerFn(getProjectContainerAppStatus);
  const startProjectApp = useServerFn(startProjectContainerApp);
  const stopProjectApp = useServerFn(stopProjectContainerApp);
  const restartProjectApp = useServerFn(restartProjectContainerApp);

  const fns = useQuery({ queryKey: ["fns", projectId], queryFn: () => lf({ data: { projectId } }) });
  const projectAppStatus = useQuery({
    queryKey: ["project-app", projectId],
    queryFn: () => loadProjectAppStatus({ data: { projectId } }),
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
  const canCreateFunction = runtime.id !== "java" || fns.data?.length === 0;
  const appRunningStatus = projectAppStatus.data?.runningStatus ?? "Unknown";
  const appStatusMeta = containerAppStatusMeta(appRunningStatus);
  const appHasContainer = Boolean(projectAppStatus.data?.containerAppName);
  const appIsRunning = appRunningStatus.toLowerCase() === "running";
  const appIsStopped = appRunningStatus.toLowerCase() === "stopped";

  // Note: no auto-select — user lands on the functions list and picks one explicitly.

  const [newFnOpen, setNewFnOpen] = useState(false);
  const [newFnName, setNewFnName] = useState("");
  const createMut = useMutation({
    mutationFn: (n: string) => cf({ data: { projectId, name: n } }),
    onSuccess: (f: any) => {
      toast.success("Función creada");
      qc.invalidateQueries({ queryKey: ["fns", projectId] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      setFunctionId(f.id);
      setNewFnOpen(false); setNewFnName("");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error"),
  });

  const refreshProjectAppState = () => {
    qc.invalidateQueries({ queryKey: ["project-app", projectId] });
    qc.invalidateQueries({ queryKey: ["projects"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const copyProjectId = async () => {
    try {
      await navigator.clipboard.writeText(projectId);
      toast.success("Project ID copiado");
    } catch {
      toast.error("No se pudo copiar el Project ID");
    }
  };

  const startAppMut = useMutation({
    mutationFn: () => startProjectApp({ data: { projectId } }),
    onSuccess: () => {
      toast.success("Container app iniciada");
      refreshProjectAppState();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error"),
  });

  const stopAppMut = useMutation({
    mutationFn: () => stopProjectApp({ data: { projectId } }),
    onSuccess: () => {
      toast.success("Container app detenida");
      refreshProjectAppState();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error"),
  });

  const restartAppMut = useMutation({
    mutationFn: () => restartProjectApp({ data: { projectId } }),
    onSuccess: () => {
      toast.success("Container app reiniciada");
      refreshProjectAppState();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error"),
  });

  const appIsBusy =
    projectAppStatus.isLoading ||
    startAppMut.isPending ||
    stopAppMut.isPending ||
    restartAppMut.isPending;

  const exportProject = async () => {
    const token = getAccessToken();
    if (!token) {
      toast.error("No se encontró el token de sesión. Vuelve a iniciar sesión.");
      return;
    }

    setExporting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/export`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        const text = await res.text();
        let message = text || `Error ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { error?: string; message?: string };
          message = parsed.error ?? parsed.message ?? message;
        } catch {
          // keep the raw text
        }
        throw new Error(message);
      }

      const blob = await res.blob();
      const filename =
        filenameFromContentDisposition(res.headers.get("content-disposition")) ??
        `${projectSlug}-functions.zip`;
      triggerDownload(blob, filename);
      toast.success("Exportación generada");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo exportar el proyecto");
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <header className="h-14 border-b border-border px-4 flex items-center gap-2 shrink-0">
        <span className="text-xs font-mono uppercase text-muted-foreground">Proyecto</span>
        <Dialog open={newFnOpen} onOpenChange={setNewFnOpen}>
          <DialogTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="gap-1 ml-2"
              disabled={!canCreateFunction || createMut.isPending}
              title={
                runtime.id === "java" && fns.data?.length
                  ? "Java solo permite una función por proyecto. Edita App.java para agregar métodos."
                  : undefined
              }
            >
              <Plus className="w-3.5 h-3.5" />Nueva función
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Nueva función</DialogTitle></DialogHeader>
            <div className="space-y-2">
              <Label>Nombre</Label>
              <Input value={newFnName} onChange={(e) => setNewFnName(e.target.value)} placeholder="hello-world" />
            </div>
            <DialogFooter>
              <Button disabled={!newFnName || createMut.isPending} onClick={() => createMut.mutate(newFnName)}>
                {createMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Crear"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {runtime.id === "java" && fns.data?.length ? (
          <span className="text-xs text-muted-foreground">
            Java usa una sola API por proyecto. Agrega métodos dentro de{" "}
            <span className="font-mono">App.java</span>.
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={onInstallCli}
            disabled={installingCli}
            title="Descarga el instalador del CLI local"
          >
            {installingCli ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Instalar CLI
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={exportProject}
            disabled={exporting}
            title="Descarga un ZIP con todas las funciones del proyecto"
          >
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Exportar ZIP
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={async () => {
            if (!confirm("¿Borrar proyecto entero?")) return;
            await dp({ data: { id: projectId } });
            toast.success("Proyecto borrado");
            onProjectDeleted();
          }}>
            Borrar proyecto
          </Button>
        </div>
      </header>

      <div className="border-b border-border/60 bg-background/50 px-4 py-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
              Project ID
            </span>
            <button
              type="button"
              onClick={copyProjectId}
              className="inline-flex max-w-full items-center gap-2 rounded-md border border-border/70 bg-background/80 px-3 py-2 text-left transition hover:border-primary/50 hover:bg-background"
              title="Copiar Project ID"
            >
              <span className="max-w-[280px] truncate font-mono text-xs text-foreground">
                {projectId}
              </span>
              <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
          </div>
          <Badge className={`gap-1 border ${appStatusMeta.className}`}>
            <span className={`h-2 w-2 rounded-full ${appStatusMeta.dotClass}`} />
            {appStatusMeta.label}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {projectAppStatus.data?.containerAppName
              ? projectAppStatus.data.containerAppName
              : "Aún sin container app"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={() => startAppMut.mutate()}
            disabled={!appHasContainer || appIsBusy || appIsRunning}
            title={!appHasContainer ? "Primero debes desplegar el proyecto" : "Correr container app"}
          >
            {startAppMut.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Correr
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={() => stopAppMut.mutate()}
            disabled={!appHasContainer || appIsBusy || appIsStopped}
            title={!appHasContainer ? "Primero debes desplegar el proyecto" : "Parar container app"}
          >
            {stopAppMut.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <XCircle className="h-3.5 w-3.5" />
            )}
            Parar
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={() => restartAppMut.mutate()}
            disabled={!appHasContainer || appIsBusy}
            title={!appHasContainer ? "Primero debes desplegar el proyecto" : "Reiniciar container app"}
          >
            {restartAppMut.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Reiniciar
          </Button>
        </div>
      </div>

      {fns.data && fns.data.length > 0 ? (
        <FunctionsAndEditor
          projectId={projectId}
          projectRuntime={projectRuntime}
          functions={fns.data}
          functionId={functionId}
          setFunctionId={setFunctionId}
          activeFile={activeFile}
          setActiveFile={setActiveFile}
          onDeleteFunction={async (id) => {
          if (!confirm("¿Borrar función?")) return;
          await df({ data: { id } });
          qc.invalidateQueries({ queryKey: ["fns", projectId] });
          qc.invalidateQueries({ queryKey: ["dashboard"] });
          if (functionId === id) setFunctionId(null);
          toast.success("Función borrada");
        }}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Crea una función para empezar.
        </div>
      )}
    </>
  );
}

function FunctionsAndEditor({
  projectId, projectRuntime, functions, functionId, setFunctionId, activeFile, setActiveFile, onDeleteFunction,
}: {
  projectId: string;
  projectRuntime: string;
  functions: Array<{ id: string; name: string; slug: string; status: string; fqdn: string | null; created_at: string; updated_at: string }>;
  functionId: string | null;
  setFunctionId: (id: string | null) => void;
  activeFile: string;
  setActiveFile: (p: string) => void;
  onDeleteFunction: (id: string) => void;
}) {
  if (!functionId) {
    return (
      <FunctionsTable
        projectId={projectId}
        functions={functions}
        onOpen={setFunctionId}
        onDelete={onDeleteFunction}
      />
    );
  }
  const current = functions.find((f) => f.id === functionId);
  return (
    <FunctionDetail
      key={functionId}
      projectId={projectId}
      projectRuntime={projectRuntime}
      functionId={functionId}
      current={current}
      activeFile={activeFile}
      setActiveFile={setActiveFile}
      onBack={() => setFunctionId(null)}
      onDelete={() => onDeleteFunction(functionId)}
    />
  );
}

function FunctionDetail({
  projectId, projectRuntime, functionId, current, activeFile, setActiveFile, onBack, onDelete,
}: {
  projectId: string;
  projectRuntime: string;
  functionId: string;
  current: { id: string; name: string; slug: string; status: string; fqdn: string | null } | undefined;
  activeFile: string;
  setActiveFile: (p: string) => void;
  onBack: () => void;
  onDelete: () => void;
}) {
  const [tab, setTab] = useState<"overview" | "logs" | "code" | "tokens" | "secrets" | "deploys">("code");
  const runtime = getRuntimeConfig(projectRuntime);
  const url = current?.fqdn
    ? runtime.multiFunction
      ? `https://${current.fqdn}/${current.slug}`
      : `https://${current.fqdn}/`
    : null;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-background">
      {/* Breadcrumb */}
      <div className="px-6 pt-4 pb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <button onClick={onBack} className="hover:text-foreground flex items-center gap-1">
          <ArrowLeft className="w-3 h-3" />Funciones
        </button>
        <span>/</span>
        <span className="text-foreground">{current?.name}</span>
      </div>

      {/* Header */}
      <div className="px-6 pb-4 flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-display font-semibold flex items-center gap-2">
            {current?.name}
            {current?.status === "live"
              ? <Badge variant="outline" className="gap-1 border-success/40 text-success text-[10px]"><span className="w-1.5 h-1.5 rounded-full bg-success" />live</Badge>
              : <Badge variant="outline" className="text-[10px] text-muted-foreground">sin desplegar</Badge>}
            <HealthBadge projectId={projectId} />
          </h1>
          {url ? (
            <div className="mt-1 flex items-center gap-2 text-xs font-mono text-muted-foreground">
              <span className="truncate" title={url}>{url}</span>
              <button onClick={() => { navigator.clipboard.writeText(url); toast.success("URL copiada"); }}
                className="hover:text-foreground"><Copy className="w-3 h-3" /></button>
              <a href={url} target="_blank" rel="noreferrer" className="hover:text-foreground"><ExternalLink className="w-3 h-3" /></a>
            </div>
          ) : (
            <div className="mt-1 text-xs text-muted-foreground">Aún no desplegada — usa el botón Deploy en la pestaña Code.</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="ghost" className="text-destructive gap-1" onClick={onDelete}>
            <Trash2 className="w-3.5 h-3.5" />Borrar
          </Button>
        </div>
      </div>

      {/* Tabs nav (Supabase-style underline) */}
      <div className="px-6 border-b border-border flex items-center gap-1 shrink-0">
        {([
          { id: "overview", label: "Overview", icon: FolderOpen },
          { id: "logs", label: "Logs", icon: Activity },
          { id: "code", label: "Code", icon: FileCode },
          { id: "tokens", label: "Tokens", icon: Lock },
          { id: "secrets", label: "Secrets", icon: Lock },
          { id: "deploys", label: "Deploys", icon: Rocket },
        ] as const).map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-sm flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />{t.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "overview" && (
          <OverviewPanel projectId={projectId} current={current} url={url} onGoCode={() => setTab("code")} />
        )}
        {/* Keep Code mounted across tab changes so unsaved draft is preserved */}
        <div className={tab === "code" ? "contents" : "hidden"}>
          <FunctionView
            functionId={functionId}
            projectId={projectId}
            projectRuntime={projectRuntime}
            activeFile={activeFile}
            setActiveFile={setActiveFile}
          />
        </div>
        {tab === "logs" && <SystemLogsPanel projectId={projectId} />}
        {tab === "tokens" && <div className="p-6 max-w-2xl"><TokensPanel functionId={functionId} projectRuntime={projectRuntime} /></div>}
        {tab === "secrets" && <div className="p-6 max-w-2xl"><SecretsPanel projectId={projectId} projectRuntime={projectRuntime} /></div>}
        {tab === "deploys" && <DeploysTabPanel projectId={projectId} />}
      </div>
    </div>
  );
}

function OverviewPanel({
  projectId, current, url, onGoCode,
}: {
  projectId: string;
  current: { id: string; name: string; slug: string; status: string; fqdn: string | null } | undefined;
  url: string | null;
  onGoCode: () => void;
}) {
  return (
    <div className="p-6 max-w-3xl space-y-4">
      <div className="border border-border rounded-lg p-4 bg-card/40">
        <div className="text-xs uppercase font-mono text-muted-foreground mb-2">Endpoint</div>
        {url ? (
          <div className="font-mono text-sm break-all">{url}</div>
        ) : (
          <div className="text-sm text-muted-foreground">Sin URL pública. Despliega la función desde la pestaña Code.</div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="border border-border rounded-lg p-4 bg-card/40">
          <div className="text-xs uppercase font-mono text-muted-foreground">Estado</div>
          <div className="mt-1 font-medium flex items-center gap-2">
            {current?.status === "live" ? "Live" : "Sin desplegar"}
            <HealthBadge projectId={projectId} showWhenNotDeployed />
          </div>
        </div>
        <div className="border border-border rounded-lg p-4 bg-card/40">
          <div className="text-xs uppercase font-mono text-muted-foreground">Slug</div>
          <div className="mt-1 font-mono text-sm">/{current?.slug}/</div>
        </div>
      </div>
      <Button onClick={onGoCode} variant="outline" className="gap-1"><FileCode className="w-4 h-4" />Editar código</Button>
    </div>
  );
}

function DeploysTabPanel({ projectId }: { projectId: string }) {
  const ld = useServerFn(listDeployments);
  const deployments = useQuery({
    queryKey: ["deps", projectId],
    queryFn: () => ld({ data: { projectId } }),
    refetchInterval: 15000,
  });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const items = deployments.data ?? [];
  const filtered = items.filter((d: any) => {
    if (statusFilter !== "all" && d.status !== statusFilter) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      String(d.version).includes(q) ||
      (d.status ?? "").toLowerCase().includes(q) ||
      (d.fqdn ?? "").toLowerCase().includes(q) ||
      (d.error ?? "").toLowerCase().includes(q)
    );
  });

  const statusBadge = (s: string) => {
    if (s === "live") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    if (s === "failed") return "bg-destructive/15 text-destructive border-destructive/30";
    if (s === "provisioning" || s === "building") return "bg-blue-500/15 text-blue-400 border-blue-500/30";
    return "bg-muted/30 text-muted-foreground border-border";
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-3 border-b border-border flex items-center gap-2 bg-sidebar/30">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar deploys…"
          className="h-8 max-w-xs text-xs"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-8 px-2 text-xs bg-card border border-border rounded font-mono"
        >
          <option value="all">Todos</option>
          <option value="live">live</option>
          <option value="failed">failed</option>
          <option value="provisioning">provisioning</option>
          <option value="building">building</option>
        </select>
        <span className="text-[10px] text-muted-foreground ml-2 font-mono">
          {filtered.length} / {items.length}
        </span>
        <div className="ml-auto">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => deployments.refetch()}>
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="font-mono text-xs">
          <div className="grid grid-cols-[140px_60px_90px_1fr_90px] gap-3 px-6 py-2 border-b border-border bg-sidebar/20 text-[10px] uppercase text-muted-foreground tracking-wider">
            <div>Timestamp</div>
            <div>Version</div>
            <div>Status</div>
            <div>Detalle</div>
            <div className="text-right">Duración</div>
          </div>
          {filtered.length === 0 && (
            <div className="text-muted-foreground text-center py-12 text-xs">Sin deploys.</div>
          )}
          {filtered.map((d: any) => {
            const open = expanded[d.id];
            const ts = new Date(d.created_at);
            const finished = d.finished_at ? new Date(d.finished_at) : null;
            const dur = finished ? `${Math.round((finished.getTime() - ts.getTime()) / 1000)}s` : "—";
            const summary = d.error ?? d.fqdn ?? d.status;
            return (
              <div key={d.id} className="border-b border-border/60">
                <button
                  onClick={() => setExpanded((e) => ({ ...e, [d.id]: !open }))}
                  className="w-full grid grid-cols-[140px_60px_90px_1fr_90px] gap-3 px-6 py-2 text-left hover:bg-sidebar/30 transition-colors items-center"
                >
                  <span className="text-muted-foreground text-[11px]">
                    {ts.toLocaleDateString()} {ts.toLocaleTimeString()}
                  </span>
                  <span className="font-semibold">v{d.version}</span>
                  <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] w-fit ${statusBadge(d.status)}`}>
                    {d.status}
                  </span>
                  <span className="truncate text-foreground/80">{summary}</span>
                  <span className="text-right text-muted-foreground text-[11px]">{dur}</span>
                </button>
                {open && (
                  <div className="px-6 pb-3 bg-card/30">
                    <div className="grid grid-cols-2 gap-3 text-[11px] py-2">
                      <div><span className="text-muted-foreground">ID:</span> {d.id}</div>
                      <div><span className="text-muted-foreground">Image:</span> {d.image ?? "—"}</div>
                      <div><span className="text-muted-foreground">FQDN:</span> {d.fqdn ?? "—"}</div>
                      <div><span className="text-muted-foreground">Revision:</span> {d.revision_name ?? "—"}</div>
                      <div><span className="text-muted-foreground">Iniciado:</span> {ts.toLocaleString()}</div>
                      <div><span className="text-muted-foreground">Finalizado:</span> {finished?.toLocaleString() ?? "—"}</div>
                    </div>
                    {d.error && (
                      <div>
                        <div className="text-[10px] uppercase text-muted-foreground mb-1">Error</div>
                        <pre className="text-[11px] whitespace-pre-wrap break-all bg-destructive/10 border border-destructive/30 text-destructive p-2 rounded max-h-64 overflow-auto">{d.error}</pre>
                      </div>
                    )}
                    {d.logs && (
                      <div className="mt-2">
                        <div className="text-[10px] uppercase text-muted-foreground mb-1">Logs</div>
                        <pre className="text-[11px] whitespace-pre-wrap break-all bg-background border border-border p-2 rounded max-h-96 overflow-auto">{typeof d.logs === "string" ? d.logs : JSON.stringify(d.logs, null, 2)}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}


type JavaRouteMatch = {
  id: string;
  annotation: "Get" | "Post" | "Put" | "Patch" | "Delete" | "Request";
  path: string;
  ordinal: number;
};

const JAVA_ROUTE_REGEX = /@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:(?:path|value)\s*=\s*)?"([^"]*)"\s*\)/g;

function extractJavaRoutes(source: string): JavaRouteMatch[] {
  const routes: JavaRouteMatch[] = [];
  let ordinal = 0;
  for (const match of source.matchAll(JAVA_ROUTE_REGEX)) {
    routes.push({
      id: `${match[1]}-${ordinal}`,
      annotation: match[1] as JavaRouteMatch["annotation"],
      path: match[2] ?? "",
      ordinal,
    });
    ordinal += 1;
  }
  return routes;
}

function normalizeJavaPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function replaceJavaRoute(source: string, route: JavaRouteMatch, nextPath: string): string {
  let ordinal = 0;
  return source.replace(JAVA_ROUTE_REGEX, (full, annotation) => {
    const currentOrdinal = ordinal++;
    if (currentOrdinal !== route.ordinal || annotation !== route.annotation) return full;
    return `@${annotation}Mapping("${nextPath}")`;
  });
}


function JavaRoutesPanel({
  fileId,
  code,
  onChange,
}: {
  fileId: string;
  code: string;
  onChange: (next: string) => void;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const routes = useMemo(() => extractJavaRoutes(code), [code]);

  useEffect(() => {
    setRefreshKey((n) => n + 1);
  }, [fileId]);

  if (routes.length === 0) return null;

  return (
    <div className="border-b border-border bg-card/35 px-3 py-2 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
          Rutas Java
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-[11px] gap-1"
          onClick={() => setRefreshKey((n) => n + 1)}
        >
          <RefreshCw className="w-3 h-3" />
          Sincronizar
        </Button>
      </div>
      <div key={`${fileId}-${refreshKey}`} className="grid gap-2">
        {routes.map((route) => (
          <form
            key={`${route.id}-${route.path}`}
            className="grid grid-cols-[110px_1fr_auto] gap-2 items-center"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const nextPath = normalizeJavaPath(String(form.get("path") ?? ""));
              onChange(replaceJavaRoute(code, route, nextPath));
            }}
          >
            <div className="font-mono text-[11px] text-muted-foreground truncate" title={`@${route.annotation}Mapping`}>
              @{route.annotation}Mapping
            </div>
            <Input
              name="path"
              defaultValue={route.path}
              className="h-8 text-xs font-mono"
              spellCheck={false}
            />
            <Button type="submit" size="sm" variant="outline" className="h-8 px-3 text-xs">
              Aplicar
            </Button>
          </form>
        ))}
      </div>
      <div className="text-[10px] text-muted-foreground">
        Cambia las rutas aquí o directamente en <span className="font-mono">App.java</span>.
      </div>
    </div>
  );
}


function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "ahora";
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} d`;
  if (diff < 86400 * 365) return `${Math.floor(diff / 86400 / 30)} meses`;
  return `${Math.floor(diff / 86400 / 365)} años`;
}

function FunctionsTable({
  projectId, functions, onOpen, onDelete,
}: {
  projectId: string;
  functions: Array<{ id: string; name: string; slug: string; status: string; fqdn: string | null; created_at: string; updated_at: string }>;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const ld = useServerFn(listDeployments);
  const deps = useQuery({ queryKey: ["deps", projectId], queryFn: () => ld({ data: { projectId } }) });
  const depCount = deps.data?.length ?? 0;
  const copyUrl = (url: string) => { navigator.clipboard.writeText(url); toast.success("URL copiada"); };

  const filtered = useMemo(
    () => functions.filter((f) => f.name.toLowerCase().includes(query.toLowerCase())),
    [functions, query],
  );

  return (
    <ScrollArea className="flex-1">
      <div className="px-8 py-6">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-display font-semibold">Funciones</h1>
            <p className="text-sm text-muted-foreground mt-1">Ejecuta lógica de servidor cerca de tus usuarios.</p>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-4">
          <div className="relative flex-1 max-w-sm">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar función…"
              className="h-9 pl-3"
            />
          </div>
          <span className="text-xs text-muted-foreground ml-2">
            Mostrando {filtered.length} de {functions.length}
          </span>
        </div>

        <div className="border border-border rounded-lg overflow-hidden bg-card/30">
          <div className="grid grid-cols-[2fr_3fr_1fr_1fr_1fr_auto] gap-4 px-4 py-3 border-b border-border bg-sidebar/40 text-[10px] font-mono uppercase text-muted-foreground tracking-wider">
            <div>Name</div>
            <div>URL</div>
            <div>Creado</div>
            <div>Actualizado</div>
            <div>Deploys</div>
            <div className="w-8" />
          </div>

          {filtered.length === 0 && (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              No hay funciones que coincidan.
            </div>
          )}

          {filtered.map((f) => {
            const url = f.fqdn ? `https://${f.fqdn}/${f.slug}` : null;
            return (
              <div
                key={f.id}
                onClick={() => onOpen(f.id)}
                className="group grid grid-cols-[2fr_3fr_1fr_1fr_1fr_auto] gap-4 px-4 py-3.5 border-b border-border last:border-b-0 items-center cursor-pointer hover:bg-sidebar/40 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <FileCode className="w-3.5 h-3.5 text-primary shrink-0" />
                  <span className="font-medium truncate">{f.name}</span>
                  {f.status === "live" && <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" title="live" />}
                </div>
                <div className="flex items-center gap-2 min-w-0 text-xs font-mono text-muted-foreground">
                  {url ? (
                    <>
                      <span className="truncate" title={url}>{url}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); copyUrl(url); }}
                        className="opacity-60 hover:opacity-100 shrink-0"
                        title="Copiar"
                      ><Copy className="w-3 h-3" /></button>
                    </>
                  ) : (
                    <span className="text-muted-foreground/50">sin desplegar</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{timeAgo(f.created_at)}</div>
                <div className="text-xs text-muted-foreground">{timeAgo(f.updated_at)}</div>
                <div className="text-xs text-muted-foreground font-mono">{depCount}</div>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(f.id); }}
                  className="opacity-0 group-hover:opacity-100 text-destructive p-1 rounded hover:bg-destructive/10"
                  title="Borrar"
                ><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            );
          })}
        </div>
      </div>
    </ScrollArea>
  );
}




function FunctionView({
  functionId, projectId, projectRuntime, activeFile, setActiveFile,
}: {
  functionId: string; projectId: string; projectRuntime: string;
  activeFile: string; setActiveFile: (p: string) => void;
}) {
  const qc = useQueryClient();
  const lfi = useServerFn(listFiles);
  const ufi = useServerFn(upsertFile);
  const cdir = useServerFn(createDirectory);
  const dfi = useServerFn(deleteFile);
  const rfi = useServerFn(renameFile);
  const dep = useServerFn(deployProject);
  const ld = useServerFn(listDeployments);
  const vfn = useServerFn(validateFunction);
  const ai = useServerFn(aiAssist);
  const runtime = getRuntimeConfig(projectRuntime);
  const isJavaProject = runtime.id === "java";
  const [draft, setDraft] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState<{ ok: boolean; error?: string } | null>(null);
  const [selectedNode, setSelectedNode] = useState<{ path: string; kind: "file" | "dir" } | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiMode, setAiMode] = useState<"generate" | "fix" | "explain">("generate");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiResult, setAiResult] = useState<string>("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renamePath, setRenamePath] = useState("");

  const files = useQuery({ queryKey: ["files", functionId], queryFn: () => lfi({ data: { functionId } }) });
  const deployments = useQuery({ queryKey: ["deps", projectId], queryFn: () => ld({ data: { projectId } }) });

  const fileEntries = useMemo(
    () => (files.data ?? []).filter((file) => file.kind !== "dir"),
    [files.data],
  );
  const current = useMemo(
    () => fileEntries.find((f) => f.path === activeFile) ?? fileEntries[0],
    [fileEntries, activeFile],
  );
  const hasFiles = fileEntries.length > 0;
  const javaPackageRoot = useMemo(() => {
    const javaFile = fileEntries.find((file) => file.path.startsWith("src/main/java/") && file.path.endsWith(".java"));
    if (!javaFile) return "src/main/java/com/miempresa";
    return javaFile.path.split("/").slice(0, -1).join("/");
  }, [fileEntries]);
  const createBasePath = useMemo(() => {
    if (selectedNode) {
      return selectedNode.kind === "dir" ? selectedNode.path : parentPath(selectedNode.path);
    }
    if (current?.path) return parentPath(current.path);
    if (runtime.id === "java") return javaPackageRoot;
    if (runtime.id === "dotnet") return "Controllers";
    if (runtime.id === "python") return "api";
    if (runtime.id === "node") return "api";
    return "_shared";
  }, [current?.path, javaPackageRoot, runtime.id, selectedNode]);
  const createFileTail =
    runtime.id === "java" ? "UserController.java"
      : runtime.id === "dotnet" ? "HelloController.cs"
      : runtime.id === "python" ? "users.py"
      : runtime.id === "node" ? "users.js"
      : "utils.ts";
  const createDirTail =
    runtime.id === "java" ? "controller"
      : runtime.id === "dotnet" ? "Controllers"
      : runtime.id === "python" ? "api"
      : runtime.id === "node" ? "api"
      : "_shared";
  const hasDeployments = (deployments.data?.length ?? 0) > 0;
  const newFilePlaceholder = createBasePath ? `${createBasePath}/${createFileTail}` : createFileTail;
  const newDirPlaceholder = createBasePath ? `${createBasePath}/${createDirTail}` : createDirTail;

  useEffect(() => {
    setSelectedNode(null);
  }, [functionId]);

  useEffect(() => {
    if (current) {
      setDraft(current.content);
      setDirty(false);
      setActiveFile(current.path);
      setValidation(null);
      setSelectedNode({ path: current.path, kind: current.kind });
      return;
    }
    setDraft("");
    setDirty(false);
    setValidation(null);
  }, [current?.id]);

  useEffect(() => {
    if (current?.path) setRenamePath(current.path);
  }, [current?.path]);

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!current) throw new Error("No hay archivo seleccionado");
      await ufi({ data: { functionId, path: current.path, content: draft } });
    },
    onSuccess: () => { setDirty(false); qc.invalidateQueries({ queryKey: ["files", functionId] }); toast.success("Guardado (hot-reload en ~3s, sin redeploy)"); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error"),
  });

  const validateMut = useMutation({
    mutationFn: async () => {
      if (!current) throw new Error("No hay archivo seleccionado");
      if (dirty && current) await ufi({ data: { functionId, path: current.path, content: draft } });
      return vfn({ data: { functionId } });
    },
    onSuccess: (r) => {
      setValidation(r);
      if (r.ok) { toast.success("✓ Compila correctamente"); setDirty(false); qc.invalidateQueries({ queryKey: ["files", functionId] }); }
      else toast.error("Falló la validación");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error"),
  });

  const deployMut = useMutation({
    mutationFn: async () => {
      if (!hasFiles) throw new Error("La función no tiene archivos para desplegar");
      if (dirty && current) await ufi({ data: { functionId, path: current.path, content: draft } });
      // Validate first so structural issues surface before we publish a new revision.
      // Known runner/env errors should not block deploy because deploy is what updates the runner.
      const v = await vfn({ data: { functionId } }).catch(() => ({ ok: true }));
      const validationResult = v as { ok: boolean; error?: string; code?: string };
      const validationError = validationResult.error ?? "";
      const normalizedValidationError = normalizeValidationText(validationError);
      const validationCode = validationResult.code ?? "";
      const canDeployPastValidation =
        validationCode === "PROJECT_NOT_DEPLOYED" ||
        validationCode === "CONTAINER_UNAVAILABLE" ||
        validationCode === "RUNNER_OUTDATED" ||
        validationCode === "NETWORK_ERROR" ||
        normalizedValidationError.includes("no esta desplegado") ||
        normalizedValidationError.includes("missing connection parameters") ||
        normalizedValidationError.includes("version anterior del runner") ||
        normalizedValidationError.includes("addrinuse") ||
        normalizedValidationError.includes("address already in use") ||
        normalizedValidationError.includes("no se pudo validar porque el contenedor no responde") ||
        normalizedValidationError.includes("no se pudo contactar con el contenedor");
      if (!validationResult.ok && validationError && !canDeployPastValidation) {
        throw new Error(`Validación falló: ${validationError}`);
      }
      return dep({ data: { projectId } });
    },
    onSuccess: (r) => {
      setDirty(false); setValidation({ ok: true });
      toast.success(`${hasDeployments ? "Redeploy" : "Deploy"} completado v${r.version}`);
      qc.invalidateQueries({ queryKey: ["deps", projectId] });
      qc.invalidateQueries({ queryKey: ["fns", projectId] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error de deploy"),
  });

  const aiMut = useMutation({
    mutationFn: () => ai({
      data: {
        mode: aiMode,
        prompt: aiPrompt,
        code: draft,
        error: validation && !validation.ok ? validation.error : undefined,
      },
    }),
    onSuccess: (r) => {
      setAiResult(r.content);
      if (aiMode !== "explain") {
        setDraft(r.content); setDirty(true);
        toast.success("Código generado — revísalo y guarda");
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error"),
  });

  const renameCurrentFile = async () => {
    if (!current) return;
    const nextPath = renamePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!nextPath || nextPath === current.path) return;

    try {
      if (dirty) {
        await ufi({ data: { functionId, path: current.path, content: draft } });
      }

      const updated = await rfi({ data: { id: current.id, path: nextPath } });
      setDraft(updated.content ?? draft);
      setDirty(false);
      setValidation(null);
      setSelectedNode({ path: updated.path, kind: updated.kind });
      qc.setQueryData<Array<{ id: string; path: string; content: string; updated_at: string; kind: "file" | "dir" }>>(
        ["files", functionId],
        (prev) => (prev ?? []).map((file) =>
          file.id === current.id
            ? { ...file, path: updated.path, content: updated.content ?? file.content }
            : file,
        ),
      );
      setActiveFile(updated.path);
      qc.invalidateQueries({ queryKey: ["files", functionId] });
      toast.success("Archivo renombrado");
      setRenameOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo renombrar el archivo");
    }
  };

  const [newFilePath, setNewFilePath] = useState("");
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newDirPath, setNewDirPath] = useState("");
  const [newDirOpen, setNewDirOpen] = useState(false);
  const openNewFileDialog = (open: boolean) => {
    setNewFileOpen(open);
    if (open) setNewFilePath(newFilePlaceholder);
  };
  const openNewDirDialog = (open: boolean) => {
    setNewDirOpen(open);
    if (open) setNewDirPath(newDirPlaceholder);
  };

  const deleteNode = async (path: string, kind: "file" | "dir") => {
    const description = kind === "dir"
      ? `Borrar carpeta ${path} y todo su contenido?`
      : `Borrar archivo ${path}?`;
    if (!confirm(description)) return;
    try {
      await dfi({ data: { functionId, path } });
      qc.invalidateQueries({ queryKey: ["files", functionId] });
      if (activeFile === path || activeFile.startsWith(`${path}/`)) {
        setActiveFile("");
        setDraft("");
        setDirty(false);
        setValidation(null);
      }
      if (selectedNode && (selectedNode.path === path || selectedNode.path.startsWith(`${path}/`))) {
        setSelectedNode(null);
      }
      toast.success(kind === "dir" ? "Carpeta borrada" : "Archivo borrado");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo borrar");
    }
  };

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full min-h-0 overflow-hidden">
      {/* Files */}
      <ResizablePanel defaultSize={32} minSize={20} className="min-w-0">
        <div className="h-full border-r border-border bg-sidebar/50 flex flex-col">
        <div className="px-3 py-2 flex items-center justify-between border-b border-border">
          <span className="text-xs font-mono uppercase text-muted-foreground">Files</span>
          <div className="flex items-center gap-1">
            {selectedNode && (
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 text-destructive hover:bg-destructive/10"
                title={`Eliminar ${selectedNode.kind === "dir" ? "carpeta" : "archivo"}`}
                onClick={() => deleteNode(selectedNode.path, selectedNode.kind)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
            <Dialog open={newFileOpen} onOpenChange={openNewFileDialog}>
              <DialogTrigger asChild>
                <Button size="icon" variant="ghost" className="h-6 w-6" title="Nuevo archivo">
                  <Plus className="w-3.5 h-3.5" />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Nuevo fichero</DialogTitle></DialogHeader>
                <Input value={newFilePath} onChange={(e) => setNewFilePath(e.target.value)} placeholder={newFilePlaceholder} />
                <p className="text-[10px] text-muted-foreground">
                  Se creará dentro de <span className="font-mono">{createBasePath || "raíz"}</span>.
                </p>
                <DialogFooter>
                  <Button onClick={async () => {
                    const nextPath = newFilePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
                    if (!nextPath) return;
                    try {
                      const created = await ufi({ data: { functionId, path: nextPath, content: "// new file\n" } });
                      qc.invalidateQueries({ queryKey: ["files", functionId] });
                      setActiveFile(created.path);
                      setSelectedNode({ path: created.path, kind: "file" });
                      setNewFileOpen(false);
                      setNewFilePath("");
                      toast.success("Archivo creado");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "No se pudo crear el archivo");
                    }
                  }}>Crear</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Dialog open={newDirOpen} onOpenChange={openNewDirDialog}>
              <DialogTrigger asChild>
                <Button size="icon" variant="ghost" className="h-6 w-6" title="Nueva carpeta">
                  <FolderPlus className="w-3.5 h-3.5" />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Nueva carpeta</DialogTitle></DialogHeader>
                <Input value={newDirPath} onChange={(e) => setNewDirPath(e.target.value)} placeholder={newDirPlaceholder} />
                <p className="text-xs text-muted-foreground">
                  Se creará dentro de <span className="font-mono">{createBasePath || "raíz"}</span>.
                </p>
                <DialogFooter>
                  <Button onClick={async () => {
                    const nextPath = newDirPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
                    if (!nextPath) return;
                    try {
                      await cdir({ data: { functionId, path: nextPath } });
                      qc.invalidateQueries({ queryKey: ["files", functionId] });
                      setSelectedNode({ path: nextPath.replace(/\/+$/, ""), kind: "dir" });
                      setNewDirOpen(false);
                      setNewDirPath("");
                      toast.success("Carpeta creada");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "No se pudo crear la carpeta");
                    }
                  }}>Crear</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <FileTree
            items={files.data ?? []}
            activePath={activeFile}
            selectedPath={selectedNode?.path ?? null}
            onOpenFile={(path) => setActiveFile(path)}
            onSelectNode={(path, kind) => setSelectedNode({ path, kind })}
            onDeletePath={deleteNode}
          />
        </ScrollArea>
        </div>
      </ResizablePanel>

      <ResizableHandle withHandle className="bg-border/70" />

      {/* Editor + side */}
      <ResizablePanel defaultSize={68} minSize={30} className="min-w-0">
        <div className="h-full flex flex-col min-w-0 overflow-hidden">
        <div className="h-10 border-b border-border bg-sidebar/70 px-3 flex items-center gap-2 shrink-0 relative z-20">
          <span className="text-xs font-mono text-muted-foreground truncate" title={current?.path}>{current?.path}</span>
          {current?.path && (
            <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
              <DialogTrigger asChild>
                <Button size="icon" variant="ghost" className="h-6 w-6" title="Renombrar archivo">
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Renombrar archivo</DialogTitle>
                </DialogHeader>
                <div className="space-y-2">
                  <Label htmlFor="rename-path">Ruta</Label>
                  <Input
                    id="rename-path"
                    value={renamePath}
                    onChange={(e) => setRenamePath(e.target.value)}
                    placeholder="src/main/java/com/miempresa/App.java"
                    className="font-mono text-xs"
                    spellCheck={false}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Si mueves un archivo Java dentro de <span className="font-mono">src/main/java</span>,
                    también actualizamos su declaración <span className="font-mono">package</span>.
                  </p>
                </div>
                <DialogFooter>
                  <Button onClick={renameCurrentFile} disabled={!renamePath || renamePath === current.path}>
                    Guardar
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
          {dirty && <span className="text-xs text-warning">● modified</span>}
          {validation && (
            validation.ok
              ? <Badge variant="outline" className="gap-1 border-success/40 text-success"><CheckCircle2 className="w-3 h-3" />compila</Badge>
              : <Badge variant="outline" className="gap-1 border-destructive/40 text-destructive"><XCircle className="w-3 h-3" />error</Badge>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Dialog open={aiOpen} onOpenChange={setAiOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="ghost" className="gap-1">
                  <Sparkles className="w-3.5 h-3.5" />IA
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader><DialogTitle className="flex items-center gap-2"><Wand2 className="w-4 h-4" />Asistente IA</DialogTitle></DialogHeader>
                <div className="flex gap-2">
                  {(["generate", "fix", "explain"] as const).map((m) => (
                    <Button key={m} size="sm" variant={aiMode === m ? "default" : "outline"} onClick={() => setAiMode(m)}>
                      {m === "generate" ? "Generar" : m === "fix" ? "Arreglar" : "Explicar"}
                    </Button>
                  ))}
                </div>
                <Textarea
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder={
                    aiMode === "generate" ? "Ej: un webhook que reciba un JSON y lo guarde en KV…" :
                    aiMode === "fix" ? "Ej: arregla el error de tipos, valida el body con zod…" :
                    "Ej: ¿qué hace este handler y qué tokens necesita?"
                  }
                  rows={4}
                  className="font-mono text-sm"
                />
                {aiMode === "fix" && validation && !validation.ok && (
                  <div className="text-xs bg-destructive/10 border border-destructive/30 rounded p-2 font-mono whitespace-pre-wrap max-h-32 overflow-auto">
                    {validation.error}
                  </div>
                )}
                {aiResult && aiMode === "explain" && (
                  <ScrollArea className="max-h-64 border border-border rounded p-3 text-sm whitespace-pre-wrap">
                    {aiResult}
                  </ScrollArea>
                )}
                <DialogFooter>
                  <Button disabled={!aiPrompt || aiMut.isPending} onClick={() => aiMut.mutate()}>
                    {aiMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Sparkles className="w-4 h-4 mr-1" />Ejecutar</>}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Button size="sm" variant="ghost" onClick={() => saveMut.mutate()} disabled={!current || !dirty || saveMut.isPending}>
              {saveMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Guardar"}
            </Button>
            <Button size="sm" variant="outline" className="gap-1" onClick={() => validateMut.mutate()} disabled={!current || validateMut.isPending}>
              {validateMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              Validar
            </Button>
            <Button size="sm" className="bg-gradient-primary text-primary-foreground shadow-glow gap-1"
              onClick={() => deployMut.mutate()} disabled={!hasFiles || deployMut.isPending}>
              {deployMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
              {hasDeployments ? "Redeploy" : "Deploy"}
            </Button>
          </div>
        </div>
        {current ? (
          <div className="flex-1 min-h-0 overflow-hidden bg-editor flex flex-col" data-color-mode="dark">
            {isJavaProject && current.path.toLowerCase().endsWith(".java") && (
              <JavaRoutesPanel
                fileId={current.path}
                code={draft}
                onChange={(next) => {
                  setDraft(next);
                  setDirty(true);
                  setValidation(null);
                }}
              />
            )}
            <div className="flex-1 min-h-0 w-full">
              <MonacoCodeEditor
                value={draft}
                path={current.path}
                language={runtime.monacoLanguage}
                onChange={(v) => {
                  setDraft(v);
                  setDirty(true);
                  setValidation(null);
                }}
              />
            </div>
            {validation && !validation.ok && (
              <div className="border-t border-destructive/40 bg-destructive/5 p-3 max-h-40 overflow-auto">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-mono uppercase text-destructive flex items-center gap-1">
                    <XCircle className="w-3 h-3" />Error de compilación
                  </span>
                  <Button size="sm" variant="ghost" className="h-6 text-xs gap-1" onClick={() => { setAiMode("fix"); setAiPrompt("Arregla este error"); setAiOpen(true); }}>
                    <Wand2 className="w-3 h-3" />Arreglar con IA
                  </Button>
                </div>
                <pre className="text-xs font-mono whitespace-pre-wrap text-destructive/90">{validation.error}</pre>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex items-center justify-center text-muted-foreground text-sm">
            Crea un archivo dentro de una carpeta para empezar a editar.
          </div>
        )}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function InvokePanel({ functionId }: { functionId: string }) {
  const inv = useServerFn(invokeFunction);
  const [method, setMethod] = useState<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">("GET");
  const [path, setPath] = useState("/");
  const [body, setBody] = useState("");
  const [headersText, setHeadersText] = useState('{\n  "content-type": "application/json"\n}');
  const [result, setResult] = useState<any>(null);
  const [reqSent, setReqSent] = useState<any>(null);
  const [view, setView] = useState<"request" | "response">("response");

  const parseHeaders = (): Record<string, string> => {
    try {
      const v = JSON.parse(headersText || "{}");
      return v && typeof v === "object" ? v as Record<string, string> : {};
    } catch { return {}; }
  };

  const mut = useMutation({
    mutationFn: () => {
      const headers = parseHeaders();
      const payload = { functionId, method, path, body: body || undefined, headers };
      setReqSent({ method, path, headers, body: body || null, sentAt: new Date().toISOString() });
      return inv({ data: payload });
    },
    onSuccess: (r) => { setResult(r); setView("response"); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error"),
  });

  const prettyJSON = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };

  return (
    <div className="p-3 space-y-3 text-sm">
      <div className="flex gap-2">
        <select value={method} onChange={(e) => setMethod(e.target.value as any)}
          className="bg-input border border-border rounded px-2 text-xs font-mono">
          {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => <option key={m}>{m}</option>)}
        </select>
        <Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono text-xs h-8" />
        <Button size="sm" onClick={() => mut.mutate()} disabled={mut.isPending}>
          {mut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
        </Button>
      </div>

      <div>
        <Label className="text-[10px] uppercase text-muted-foreground">Request headers (JSON)</Label>
        <Textarea value={headersText} onChange={(e) => setHeadersText(e.target.value)}
          className="font-mono text-[11px] h-20" spellCheck={false} />
      </div>

      {method !== "GET" && (
        <div>
          <Label className="text-[10px] uppercase text-muted-foreground">Request body</Label>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder='{"hello":"world"}'
            className="font-mono text-xs h-24" spellCheck={false} />
        </div>
      )}

      {(result || reqSent) && (
        <div className="space-y-2 border-t border-border pt-2">
          <div className="flex items-center gap-2 text-xs font-mono">
            {result && (
              <Badge variant={result.status >= 200 && result.status < 300 ? "default" : "destructive"}>
                {result.status || "ERR"}
              </Badge>
            )}
            {result && <span className="text-muted-foreground">{result.durationMs}ms</span>}
            {result?.url && (
              <a href={result.url} target="_blank" rel="noreferrer" className="ml-auto text-primary hover:underline flex items-center gap-1">
                <ExternalLink className="w-3 h-3" />url
              </a>
            )}
          </div>
          {result?.error && <div className="text-xs text-destructive font-mono">{result.error}</div>}

          <div className="flex gap-1">
            <Button size="sm" variant={view === "request" ? "default" : "outline"} className="h-6 text-[11px]" onClick={() => setView("request")}>Request</Button>
            <Button size="sm" variant={view === "response" ? "default" : "outline"} className="h-6 text-[11px]" onClick={() => setView("response")}>Response</Button>
          </div>

          {view === "request" && reqSent && (
            <div className="space-y-2">
              <div className="text-[10px] uppercase text-muted-foreground">Method & Path</div>
              <pre className="bg-card border border-border rounded p-2 text-xs font-mono overflow-auto">{reqSent.method} {reqSent.path}</pre>
              <div className="text-[10px] uppercase text-muted-foreground">Headers</div>
              <pre className="bg-card border border-border rounded p-2 text-xs font-mono overflow-auto max-h-40">{JSON.stringify(reqSent.headers, null, 2)}</pre>
              {reqSent.body && <>
                <div className="text-[10px] uppercase text-muted-foreground">Body</div>
                <pre className="bg-card border border-border rounded p-2 text-xs font-mono overflow-auto max-h-60">{prettyJSON(reqSent.body)}</pre>
              </>}
            </div>
          )}

          {view === "response" && result && (
            <div className="space-y-2">
              <div className="text-[10px] uppercase text-muted-foreground">Headers</div>
              <pre className="bg-card border border-border rounded p-2 text-xs font-mono overflow-auto max-h-40">{JSON.stringify(result.headers || {}, null, 2)}</pre>
              <div className="text-[10px] uppercase text-muted-foreground">Body</div>
              <pre className="bg-card border border-border rounded p-2 text-xs font-mono overflow-auto max-h-60">{prettyJSON(result.body || "")}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


function SecretsPanel({ projectId, projectRuntime }: { projectId: string; projectRuntime: string }) {
  const qc = useQueryClient();
  const ls = useServerFn(listSecrets);
  const us = useServerFn(upsertSecret);
  const ds = useServerFn(deleteSecret);
  const secrets = useQuery({ queryKey: ["secrets", projectId], queryFn: () => ls({ data: { projectId } }) });
  const [name, setName] = useState(""); const [value, setValue] = useState("");
  const [visible, setVisible] = useState<Record<string, boolean>>({});

  const addMut = useMutation({
    mutationFn: () => us({ data: { projectId, name, value } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["secrets", projectId] }); setName(""); setValue(""); toast.success("Guardado"); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error"),
  });

  return (
    <div className="p-3 space-y-3 text-sm">
      <div className="space-y-2 p-3 border border-border rounded-md bg-card/50">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={projectRuntime === "java" ? "SPRING_DATASOURCE_URL" : "MY_SECRET"}
          className="font-mono h-8 text-xs uppercase"
        />
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="valor" type="password" className="font-mono h-8 text-xs" />
        <Button size="sm" className="w-full" onClick={() => addMut.mutate()} disabled={!name || !value}>Añadir / actualizar</Button>
        <p className="text-[10px] text-muted-foreground">
          Secrets de proyecto · se inyectan como variables de entorno en el siguiente deploy.
          {projectRuntime === "deno" ? " En Deno siguen disponibles vía " : " En Java/Spring suelen consumirse vía "}
          <code className="font-mono">{projectRuntime === "deno" ? 'Deno.env.get("NAME")' : 'System.getenv("NAME")'}</code>.
        </p>
      </div>
      <div className="space-y-1">
        {secrets.data?.map((s) => (
          <div key={s.id} className="flex items-center gap-2 p-2 border border-border rounded text-xs">
            <span className="font-mono">{s.name}</span>
            <span className="flex-1 font-mono text-muted-foreground truncate">
              {visible[s.id] ? s.value : "••••••••"}
            </span>
            <button onClick={() => setVisible((v) => ({ ...v, [s.id]: !v[s.id] }))} className="text-muted-foreground">
              {visible[s.id] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            </button>
            <button onClick={async () => {
              await ds({ data: { id: s.id } });
              qc.invalidateQueries({ queryKey: ["secrets", projectId] });
            }}><Trash2 className="w-3 h-3 text-destructive" /></button>
          </div>
        ))}
        {secrets.data?.length === 0 && <div className="text-xs text-muted-foreground text-center py-4">Sin secrets.</div>}
      </div>
    </div>
  );
}

function DeploysPanel({ deployments }: { deployments: any[] | undefined }) {
  return (
    <div className="p-3 space-y-1 text-xs">
      {deployments?.length === 0 && <div className="text-muted-foreground text-center py-4">Sin deploys aún. Pulsa Deploy.</div>}
      {deployments?.map((d) => (
        <div key={d.id} className="p-2 border border-border rounded font-mono space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant={d.status === "live" ? "default" : d.status === "failed" ? "destructive" : "secondary"}>v{d.version}</Badge>
            <span className="text-muted-foreground">{d.status}</span>
            <span className="ml-auto text-muted-foreground">{new Date(d.created_at).toLocaleTimeString()}</span>
          </div>
          {d.fqdn && <div className="text-[10px] text-muted-foreground truncate">{d.fqdn}</div>}
          {d.error && <div className="text-[10px] text-destructive whitespace-pre-wrap">{d.error}</div>}
        </div>
      ))}
    </div>
  );
}



function SystemLogsPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const ls = useServerFn(listSystemLogs);
  const cl = useServerFn(clearSystemLogs);
  const logs = useQuery({
    queryKey: ["syslogs", projectId],
    queryFn: () => ls({ data: { projectId } }),
    refetchInterval: 10000,
    refetchIntervalInBackground: false,
  });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const items = logs.data ?? [];
  const filtered = items.filter((l: any) => {
    if (levelFilter !== "all" && l.level !== levelFilter) return false;
    if (sourceFilter !== "all" && l.source !== sourceFilter) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      (l.message ?? "").toLowerCase().includes(q) ||
      (l.source ?? "").toLowerCase().includes(q) ||
      (l.meta ?? "").toLowerCase().includes(q)
    );
  });

  const sources = Array.from(new Set(items.map((l: any) => l.source))).sort();

  const levelColor = (lvl: string) => {
    if (lvl === "error") return "text-red-400";
    if (lvl === "warn") return "text-amber-400";
    if (lvl === "debug") return "text-muted-foreground";
    return "text-sky-400";
  };

  const fmtTs = (iso: string) => {
    const d = new Date(iso);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getDate())} ${months[d.getMonth()]} ${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const renderMessage = (l: any) => {
    let metaStr = "";
    if (l.meta) {
      try {
        const obj = JSON.parse(l.meta);
        metaStr = " " + JSON.stringify(obj);
      } catch { metaStr = " " + l.meta; }
    }
    return `${l.message ?? ""}${metaStr}`;
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-3 border-b border-border flex items-center gap-2 bg-sidebar/30 flex-wrap">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search events…"
          className="h-8 max-w-xs text-xs"
        />
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          className="h-8 px-2 text-xs bg-card border border-border rounded font-mono"
        >
          <option value="all">Severity</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
          <option value="debug">debug</option>
        </select>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="h-8 px-2 text-xs bg-card border border-border rounded font-mono"
        >
          <option value="all">Source</option>
          {sources.map((s) => <option key={s as string} value={s as string}>{s as string}</option>)}
        </select>
        <span className="text-[10px] text-muted-foreground ml-2 font-mono">
          {filtered.length} / {items.length}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => logs.refetch()}>
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
          <Button
            size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Borrar logs"
            onClick={async () => {
              if (!confirm("¿Borrar todos los logs del proyecto?")) return;
              await cl({ data: { projectId } });
              qc.invalidateQueries({ queryKey: ["syslogs", projectId] });
            }}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1 bg-editor">
        <div className="font-mono text-[12px] leading-5 py-2">
          {filtered.length === 0 && (
            <div className="text-muted-foreground text-center py-12 text-xs">Sin eventos.</div>
          )}
          {filtered.map((l: any) => {
            const open = expanded[l.id];
            return (
              <div key={l.id}>
                <button
                  onClick={() => setExpanded((e) => ({ ...e, [l.id]: !open }))}
                  className="w-full px-6 py-0.5 text-left hover:bg-sidebar/40 transition-colors flex items-start gap-4 whitespace-pre"
                >
                  <span className="text-muted-foreground/70 shrink-0 select-none">{fmtTs(l.created_at)}</span>
                  <span className={`shrink-0 uppercase font-semibold w-12 ${levelColor(l.level)}`}>{l.level}</span>
                  <span className="text-foreground/90 whitespace-pre-wrap break-all flex-1">{renderMessage(l)}</span>
                </button>
                {open && l.meta && (
                  <div className="px-6 py-2 bg-card/30 border-y border-border/40">
                    <pre className="text-[11px] whitespace-pre-wrap break-all text-foreground/80">
                      {(() => { try { return JSON.stringify(JSON.parse(l.meta), null, 2); } catch { return l.meta; } })()}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

function TokensPanel({ functionId, projectRuntime }: { functionId: string; projectRuntime: string }) {
  const qc = useQueryClient();
  const lt = useServerFn(listTokens);
  const ut = useServerFn(upsertToken);
  const dt = useServerFn(deleteToken);
  const tokens = useQuery({ queryKey: ["tokens", functionId], queryFn: () => lt({ data: { functionId } }) });
  const [name, setName] = useState(""); const [value, setValue] = useState("");
  const [visible, setVisible] = useState<Record<string, boolean>>({});

  const addMut = useMutation({
    mutationFn: () => ut({ data: { functionId, name, value } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tokens", functionId] });
      setName("");
      setValue("");
      toast.success(projectRuntime === "deno"
        ? "Token guardado (activo en ~3s, sin redeploy)"
        : "Token guardado. Haz redeploy para que Java lo tome");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error"),
  });

  return (
    <div className="p-3 space-y-3 text-sm">
      <div className="space-y-2 p-3 border border-border rounded-md bg-card/50">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="API_KEY" className="font-mono h-8 text-xs uppercase" />
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="valor" type="password" className="font-mono h-8 text-xs" />
        <Button size="sm" className="w-full" onClick={() => addMut.mutate()} disabled={!name || !value}>Guardar token</Button>
        <p className="text-[10px] text-muted-foreground">
          Tokens por función ·{" "}
          {projectRuntime === "deno"
            ? "hot-reload sin redeploy · disponibles en el handler como "
            : "se inyectan en el próximo deploy · en Java usa "}
          <code className="font-mono">
            {projectRuntime === "deno" ? 'ctx.tokens["NAME"]' : 'API_KEY / X_API_KEY'}
          </code>
        </p>
      </div>
      <div className="space-y-1">
        {tokens.data?.map((t) => (
          <div key={t.id} className="flex items-center gap-2 p-2 border border-border rounded text-xs">
            <span className="font-mono">{t.name}</span>
            <span className="flex-1 font-mono text-muted-foreground truncate">
              {visible[t.id] ? t.value : "••••••••"}
            </span>
            <button onClick={() => setVisible((v) => ({ ...v, [t.id]: !v[t.id] }))} className="text-muted-foreground">
              {visible[t.id] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            </button>
            <button onClick={async () => {
              await dt({ data: { id: t.id } });
              qc.invalidateQueries({ queryKey: ["tokens", functionId] });
            }}><Trash2 className="w-3 h-3 text-destructive" /></button>
          </div>
        ))}
        {tokens.data?.length === 0 && <div className="text-xs text-muted-foreground text-center py-4">Sin tokens.</div>}
      </div>
    </div>
  );
}
