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
const onPath = (env.PATH ?? "").split(path.delimiter).some((p) => p.toLowerCase() === cargoBin.toLowerCase());
if (!onPath && fs.existsSync(cargoFile)) {
  env.PATH = `${cargoBin}${path.delimiter}${env.PATH ?? ""}`;
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
