import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthSystemAuth } from "@/lib/auth/server-middleware";

const MODEL = "gpt-4o-mini";
const GATEWAY = "https://api.openai.com/v1/chat/completions";

const SYSTEM = `You are an expert Deno/TypeScript engineer writing serverless functions for a custom runtime.
Runtime contract (CRITICAL):
- Each function exports \`export default async function handler(req: Request, ctx): Promise<Response>\` (or named \`handler\`).
- \`ctx\` has: { tokens: Record<string,string>, functionId: string }. Read API keys from \`ctx.tokens["NAME"]\` — NEVER from Deno.env, NEVER from process.env.
- Use Web standard APIs (fetch, Request, Response, crypto). Imports must be URL imports (esm.sh, deno.land/std, jsr).
- Return a \`Response\`. Use \`Response.json(...)\` for JSON.
- Multiple files allowed; entry is \`index.ts\` unless said otherwise.

When you return code, return ONLY raw TypeScript source code for the entrypoint file — no markdown fences, no commentary, no preamble. The output is written directly to disk.`;

async function callAI(messages: Array<{ role: string; content: string }>): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY no está configurada");
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, stream: false }),
  });
  if (res.status === 429) throw new Error("Has alcanzado el límite de uso de OpenAI. Intenta en un momento.");
  if (res.status === 401) throw new Error("OPENAI_API_KEY inválida. Verifica el secret.");
  if (!res.ok) throw new Error(`OpenAI: ${res.status} ${await res.text()}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? "";
  // Strip accidental code fences
  return content.replace(/^```(?:ts|typescript|js|javascript)?\n?/g, "").replace(/\n?```\s*$/g, "").trim();
}

export const aiAssist = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({
    mode: z.enum(["generate", "fix", "explain"]),
    prompt: z.string().min(1).max(4000),
    code: z.string().max(50000).optional(),
    error: z.string().max(8000).optional(),
  }).parse(d))
  .handler(async ({ data }) => {
    let messages: Array<{ role: string; content: string }>;
    if (data.mode === "generate") {
      messages = [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Write a complete handler for: ${data.prompt}\n\nReturn ONLY the TypeScript source for index.ts.` },
      ];
    } else if (data.mode === "fix") {
      messages = [
        { role: "system", content: SYSTEM },
        { role: "user", content: `The following handler fails to compile/run.\n\nError:\n${data.error ?? "(none)"}\n\nCurrent code:\n${data.code ?? ""}\n\nInstruction: ${data.prompt}\n\nReturn ONLY the corrected TypeScript source for index.ts.` },
      ];
    } else {
      messages = [
        { role: "system", content: "You are a senior engineer. Explain code clearly and concisely in Spanish, using markdown." },
        { role: "user", content: `Explain this handler. User question: ${data.prompt}\n\n${data.code ?? ""}` },
      ];
    }
    const content = await callAI(messages);
    return { content };
  });
