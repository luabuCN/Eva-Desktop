import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

// concurrently feeds each command a piped stdin that stays open forever, and
// something in the server's startup chain reads stdin synchronously — on an
// ever-open pipe that read blocks forever and the api never reaches listen
// (frontend then shows "Failed to fetch"). Give the api a dead stdin so the
// read hits EOF at once; stdout/stderr stay inherited so concurrently keeps
// prefixing the logs.
const child = spawn("pnpm --filter server dev", {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
  shell: process.platform === "win32",
});

function stopChild(signal) {
  if (process.platform === "win32" && child.pid) {
    // shell:true means child.pid is the cmd.exe wrapper; kill the whole tree
    // or an orphaned tsx child keeps holding port 8878 across restarts.
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stopChild(signal));
}

child.on("error", (error) => {
  console.error(`failed to launch api server: ${error.message}`);
  process.exit(1);
});

child.on("close", (code) => process.exit(code ?? 1));
