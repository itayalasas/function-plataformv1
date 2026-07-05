import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  RefreshCw,
  Search,
  TriangleAlert,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { listLogs } from "@/lib/api/invoke.functions";

type InvocationLogRow = {
  id: string;
  kind: string;
  method: string;
  path: string;
  target: string | null;
  status: number | null;
  duration_ms: number | null;
  error: string | null;
  request: unknown;
  response: unknown;
  meta: unknown;
  created_at: string;
};

type InvocationState = "ok" | "warn" | "error";

function normalizeJson(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function prettyJson(value: unknown): string {
  const normalized = normalizeJson(value);
  if (normalized == null) return "";
  if (typeof normalized === "string") return normalized;
  try {
    return JSON.stringify(normalized, null, 2);
  } catch {
    return String(normalized);
  }
}

function stateMeta(row: InvocationLogRow): { label: InvocationState; className: string; Icon: typeof CheckCircle2 } {
  if (row.error) {
    return {
      label: "error",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
      Icon: XCircle,
    };
  }

  if (typeof row.status !== "number" || row.status < 200) {
    return {
      label: "warn",
      className: "border-amber-500/30 bg-amber-500/10 text-amber-500",
      Icon: TriangleAlert,
    };
  }

  if (row.status >= 500) {
    return {
      label: "error",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
      Icon: XCircle,
    };
  }

  if (row.status >= 300) {
    return {
      label: "warn",
      className: "border-amber-500/30 bg-amber-500/10 text-amber-500",
      Icon: TriangleAlert,
    };
  }

  return {
    label: "ok",
    className: "border-success/30 bg-success/10 text-success",
    Icon: CheckCircle2,
  };
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function InvocationPayloadCard({
  title,
  value,
}: {
  title: string;
  value: unknown;
}) {
  const body = prettyJson(value);
  const isEmpty = !body || body === "null";

  return (
    <div className="rounded-lg border border-border bg-background/60 p-3">
      <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{title}</div>
      {isEmpty ? (
        <div className="text-xs text-muted-foreground">Sin datos guardados.</div>
      ) : (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-card/60 p-2 font-mono text-[11px] leading-5 text-foreground/90">
          {body}
        </pre>
      )}
    </div>
  );
}

export function FunctionTransactionsPanel({ functionId }: { functionId: string }) {
  const ll = useServerFn(listLogs);
  const logs = useQuery({
    queryKey: ["fn-transactions", functionId],
    queryFn: () => ll({ data: { functionId } }),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | InvocationState>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [methodFilter, setMethodFilter] = useState<string>("all");

  const items = (logs.data ?? []) as InvocationLogRow[];
  const kinds = useMemo(
    () => Array.from(new Set(items.map((item) => item.kind).filter(Boolean))).sort(),
    [items],
  );
  const methods = useMemo(
    () => Array.from(new Set(items.map((item) => item.method).filter(Boolean))).sort(),
    [items],
  );

  const filtered = items.filter((row) => {
    const state = stateMeta(row).label;
    if (stateFilter !== "all" && state !== stateFilter) return false;
    if (kindFilter !== "all" && row.kind !== kindFilter) return false;
    if (methodFilter !== "all" && row.method !== methodFilter) return false;
    if (!query) return true;

    const haystack = [
      row.kind,
      row.method,
      row.path,
      row.target,
      row.status,
      row.error,
      row.created_at,
      prettyJson(row.request),
      prettyJson(row.response),
      prettyJson(row.meta),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return haystack.includes(query.toLowerCase());
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-sidebar/30 px-6 py-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar requests, responses, errores..."
            className="h-8 w-[240px] pl-8 text-xs"
          />
        </div>
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value as "all" | InvocationState)}
          className="h-8 rounded border border-border bg-card px-2 text-xs font-mono"
        >
          <option value="all">Estado</option>
          <option value="ok">ok</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          className="h-8 rounded border border-border bg-card px-2 text-xs font-mono"
        >
          <option value="all">Tipo</option>
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
        <select
          value={methodFilter}
          onChange={(e) => setMethodFilter(e.target.value)}
          className="h-8 rounded border border-border bg-card px-2 text-xs font-mono"
        >
          <option value="all">Método</option>
          {methods.map((method) => (
            <option key={method} value={method}>
              {method}
            </option>
          ))}
        </select>
        <span className="ml-1 text-[10px] font-mono text-muted-foreground">
          {filtered.length} / {items.length}
        </span>
        <div className="ml-auto">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => logs.refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 bg-editor">
        <div className="font-mono text-[12px] leading-5 py-2">
          {logs.isLoading && (
            <div className="px-6 py-8 text-center text-xs text-muted-foreground">
              Cargando invocaciones...
            </div>
          )}
          {logs.isError && (
            <div className="px-6 py-8 text-center text-xs text-destructive">
              No se pudieron cargar las invocaciones.
              <div className="mt-1 text-[11px] text-muted-foreground normal-case">
                {logs.error instanceof Error ? logs.error.message : String(logs.error)}
              </div>
            </div>
          )}
          {!logs.isLoading && !logs.isError && filtered.length === 0 && (
            <div className="py-12 text-center text-xs text-muted-foreground">
              Todavía no hay invocaciones para esta función.
            </div>
          )}
          {!logs.isLoading &&
            !logs.isError &&
            filtered.map((row) => {
              const open = expanded[row.id];
              const state = stateMeta(row);
              const duration = typeof row.duration_ms === "number" ? `${row.duration_ms}ms` : "—";
              const statusText =
                typeof row.status === "number" && row.status > 0 ? `HTTP ${row.status}` : row.error ? "ERR" : "—";

              return (
                <div key={row.id} className="border-b border-border/60">
                  <button
                    type="button"
                    onClick={() => setExpanded((current) => ({ ...current, [row.id]: !open }))}
                    className="flex w-full items-center gap-3 px-6 py-2 text-left transition-colors hover:bg-sidebar/40"
                  >
                    <span className="shrink-0 text-[11px] text-muted-foreground/80">
                      {formatTimestamp(row.created_at)}
                    </span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Badge variant="outline" className={`gap-1 text-[10px] ${state.className}`}>
                        <state.Icon className="h-3 w-3" />
                        {state.label}
                      </Badge>
                      <Badge variant="outline" className="border-border/80 bg-background/60 text-[10px] uppercase text-muted-foreground">
                        {row.kind}
                      </Badge>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                          {row.method}
                        </Badge>
                        <span className="truncate text-foreground/90">
                          {row.path}
                        </span>
                      </div>
                      {row.target && (
                        <div className="truncate text-[11px] text-muted-foreground">
                          {row.target}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{statusText}</span>
                      <span className="inline-flex items-center gap-1">
                        <Clock3 className="h-3 w-3" />
                        {duration}
                      </span>
                      {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    </div>
                  </button>

                  {open && (
                    <div className="border-t border-border/60 bg-card/30 px-6 py-4">
                      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono text-muted-foreground">Status:</span>
                        <Badge variant="outline" className={state.className}>
                          {statusText}
                        </Badge>
                        {row.error && (
                          <span className="text-destructive font-mono">{row.error}</span>
                        )}
                      </div>

                      <div className="grid gap-3 lg:grid-cols-2">
                        <InvocationPayloadCard title="Request" value={row.request} />
                        <InvocationPayloadCard title="Response" value={row.response} />
                      </div>

                      <div className="mt-3">
                        <InvocationPayloadCard title="Meta" value={row.meta} />
                      </div>
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
