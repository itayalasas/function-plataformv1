import { WORKER_SOURCE } from "./worker-source";

export interface SandboxRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface SandboxLogEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  time: number;
  message: string;
}

export interface SandboxResult {
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
  stack?: string | null;
  logs: SandboxLogEntry[];
  durationMs: number;
}

const TIMEOUT_MS = 10_000;

export async function runInSandbox(
  code: string,
  request: SandboxRequest,
  secrets: Record<string, string> = {},
): Promise<SandboxResult> {
  const blob = new Blob([WORKER_SOURCE], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);

  return new Promise((resolve) => {
    const cleanup = () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve({
        ok: false,
        error: `Execution timed out after ${TIMEOUT_MS}ms`,
        logs: [],
        durationMs: TIMEOUT_MS,
      });
    }, TIMEOUT_MS);

    worker.onmessage = (e: MessageEvent<SandboxResult>) => {
      clearTimeout(timer);
      cleanup();
      resolve(e.data);
    };

    worker.onerror = (e) => {
      clearTimeout(timer);
      cleanup();
      resolve({
        ok: false,
        error: e.message || "Worker crashed",
        logs: [],
        durationMs: 0,
      });
    };

    worker.postMessage({ code, request, secrets });
  });
}
