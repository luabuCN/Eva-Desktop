import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

// `pnpm dev` runs the tsx API server on the same port the sidecar would bind,
// so tell the Tauri process (see src-tauri/src/main.rs) never to spawn its own
// sidecar — the two race for the port at startup and either side may lose.
const env = { ...process.env, OPENHARNESS_SKIP_SIDECAR: "1" };

// Terminals launched from an already-running Windows Terminal / VS Code inherit
// a stale PATH that may no longer include cargo, which kills `tauri dev` with
// "cargo metadata: program not found". Put the rustup bin dir back if cargo is
// installed there but not reachable.
const cargoBin = path.join(os.homedir(), ".cargo", "bin");
const cargoFile = path.join(cargoBin, process.platform === "win32" ? "cargo.exe" : "cargo");
// Windows env var names are case-insensitive but JS object keys are not — the
// inherited key is usually "Path", so assigning env.PATH would add a duplicate
// key that shadows the real PATH in the child's environment block (cmd.exe
// then only sees .cargo/bin and loses pnpm). Update the existing casing.
const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
const onPath = (env[pathKey] ?? "").split(path.delimiter).some((p) => p.toLowerCase() === cargoBin.toLowerCase());
if (!onPath && fs.existsSync(cargoFile)) {
  env[pathKey] = `${cargoBin}${path.delimiter}${env[pathKey] ?? ""}`;
}

const child = spawn("pnpm exec tauri dev", {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`failed to launch tauri dev: ${error.message}`);
  process.exit(1);
});

child.on("close", (code) => process.exit(code ?? 1));
