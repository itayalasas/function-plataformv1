import { spawn } from "node:child_process";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: run-with-system-ca.mjs <command> [args...]");
  process.exit(1);
}

const supportsSystemCa = process.allowedNodeEnvironmentFlags?.has("--use-system-ca") ?? false;
const childArgs = supportsSystemCa ? ["--use-system-ca", ...args] : args;

const child = spawn(process.execPath, childArgs, {
  stdio: "inherit",
  env: process.env,
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
