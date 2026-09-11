import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const serverDir = path.join(root, "server");
const binariesDir = path.join(root, "src-tauri", "binaries");

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function platformTarget() {
  if (process.platform === "win32" && process.arch === "x64") {
    return { target: "x86_64-pc-windows-msvc", extension: ".exe" };
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { target: "aarch64-apple-darwin", extension: "" };
  }
  if (process.platform === "darwin") {
    return { target: "x86_64-apple-darwin", extension: "" };
  }
  if (process.arch === "arm64") {
    return { target: "aarch64-unknown-linux-gnu", extension: "" };
  }
  return { target: "x86_64-unknown-linux-gnu", extension: "" };
}

const { target, extension } = platformTarget();
const seaDir = path.join(serverDir, "sea");
const sidecarPath = path.join(serverDir, "sidecar", `open-harness-sidecar${extension}`);

run("pnpm", ["--filter", "server", "build"]);
// node-pty 是原生模块：bundle 保持 external，运行时动态加载；SEA 环境
// 里加载失败时终端功能整体降级（见 runtime/terminal-hub.ts）。
run("pnpm", [
  "--filter",
  "server",
  "exec",
  "esbuild",
  "dist/index.js",
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--external:node-pty",
  "--outfile=sea/server.cjs",
]);

fs.writeFileSync(
  path.join(seaDir, "sea-config.json"),
  `${JSON.stringify(
    {
      main: "sea/server.cjs",
      output: "sea/sea-prep.blob",
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
    },
    null,
    2,
  )}\n`,
);

run("node", ["--experimental-sea-config", "sea/sea-config.json"], serverDir);
fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
fs.copyFileSync(process.execPath, sidecarPath);
// copyFileSync 不保留权限位，Linux/macOS 上需要显式加可执行位
fs.chmodSync(sidecarPath, 0o755);

// macOS 的 Node 二进制带官方签名，postject 注入前必须先移除，否则产物会被系统拒绝执行
if (process.platform === "darwin") {
  run("codesign", ["--remove-signature", sidecarPath]);
}

const postjectEnvironment = {
  ...process.env,
  NODE_SEA_BLOB: path.join(seaDir, "sea-prep.blob"),
};
const postject = spawnSync(
  "pnpm",
  [
    "--filter",
    "server",
    "exec",
    "postject",
    sidecarPath,
    "NODE_SEA_BLOB",
    path.join(seaDir, "sea-prep.blob"),
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "--overwrite",
  ],
  { cwd: root, env: postjectEnvironment, stdio: "inherit", shell: process.platform === "win32" },
);
if (postject.status !== 0) {
  throw new Error(`postject failed with exit code ${postject.status}`);
}

fs.mkdirSync(binariesDir, { recursive: true });
fs.copyFileSync(sidecarPath, path.join(binariesDir, `open-harness-sidecar-${target}${extension}`));
fs.chmodSync(path.join(binariesDir, `open-harness-sidecar-${target}${extension}`), 0o755);

console.log(`Prepared Tauri sidecar for ${target}`);
