/** BackgroundTaskHub 冒烟验证：直调 hub，覆盖 start/output(block)/超时/失败/停止/列表。
 * 运行：pnpm --filter server exec tsx scripts/smoke-background-tasks.ts */
import assert from "node:assert";
import { BackgroundTaskHub } from "../src/runtime/background-tasks.js";
import type { BackgroundTaskNotice } from "../src/runtime/background-tasks.js";

const CONV = "smoke-conv";
const notices: BackgroundTaskNotice[] = [];
const hub = new BackgroundTaskHub();
hub.notify = (notice) => {
  notices.push(notice);
  console.log(`[notice] ${notice.kind} ${notice.taskId.slice(0, 8)} ${"status" in notice ? notice.status : ""}`);
};

// 1) 正常完成的命令：exit 0 + stdout 尾部 + block 等待收敛
const ok = await hub.start({
  command: 'Write-Output "hello-from-bg"; Write-Output "second-line"',
  cwd: process.cwd(),
  conversationId: CONV,
});
assert(ok.ok, `start failed: ${!ok.ok ? ok.error : ""}`);
if (!ok.ok) process.exit(1);
console.log("1) started:", ok.taskId);

const result = await hub.output({ taskId: ok.taskId, conversationId: CONV, block: true, timeoutSeconds: 20 });
assert(result.ok, `output errored: ${!result.ok ? result.error : ""}`);
if (!result.ok) process.exit(1);
console.log("1) result:", result.task.status, "exit", result.task.exitCode, `${Math.round(result.durationMs / 100) / 10}s`);
console.log("1) stdout tail:", JSON.stringify(result.task.stdoutTail));
assert(result.task.status === "completed");
assert(result.task.exitCode === 0);
assert(result.task.stdoutTail.includes("hello-from-bg"));
assert(result.task.stdoutTail.includes("second-line"));

// 2) 非零退出码：failed + exit code + error 字段
const fail = await hub.start({ command: "node -e \"process.exit(3)\"", cwd: process.cwd(), conversationId: CONV });
assert(fail.ok);
if (!fail.ok) process.exit(1);
const failResult = await hub.output({ taskId: fail.taskId, conversationId: CONV, block: true, timeoutSeconds: 20 });
assert(failResult.ok);
if (!failResult.ok) process.exit(1);
console.log("2) fail result:", failResult.task.status, "exit", failResult.task.exitCode, "error:", failResult.task.error);
assert(failResult.task.status === "failed");
assert(failResult.task.exitCode === 3);

// 3) block 超时不算错误：返回 running + note
const slow = await hub.start({ command: "Start-Sleep -Seconds 15", cwd: process.cwd(), conversationId: CONV });
assert(slow.ok);
if (!slow.ok) process.exit(1);
const t0 = Date.now();
const slowResult = await hub.output({ taskId: slow.taskId, conversationId: CONV, block: true, timeoutSeconds: 2 });
const waited = Date.now() - t0;
assert(slowResult.ok);
if (!slowResult.ok) process.exit(1);
console.log(`3) after ~${waited}ms:`, slowResult.task.status, "note:", slowResult.note?.slice(0, 60));
assert(slowResult.task.status === "running");
assert(waited >= 1800 && waited < 8000, `unexpected wait ${waited}ms`);
assert(typeof slowResult.note === "string");

// 4) stop：running → stopped
const stoppedCount = hub.stop([slow.taskId], CONV);
const stopResult = await hub.output({ taskId: slow.taskId, conversationId: CONV, block: true, timeoutSeconds: 10 });
assert(stopResult.ok);
if (!stopResult.ok) process.exit(1);
console.log("4) stopped:", stoppedCount, "->", stopResult.task.status);
assert(stoppedCount === 1);
assert(stopResult.task.status === "stopped");

// 5) 会话过滤 + 缺省 taskId（最近一个）
const otherConv = await hub.start({ command: 'Write-Output "other"', cwd: process.cwd(), conversationId: "other-conv" });
assert(otherConv.ok);
const otherResult = await hub.output({ taskId: otherConv.taskId, conversationId: "other-conv", block: true, timeoutSeconds: 10 });
assert(otherResult.ok);
if (!otherResult.ok) process.exit(1);
const mine = hub.list(CONV);
const others = hub.list("other-conv");
console.log(`5) list(${CONV}):`, mine.length, "other-conv:", others.length);
assert(mine.length === 3); // 本会话 3 个（ok/fail/slow），other-conv 的不混入
const latest = await hub.output({ conversationId: CONV });
assert(latest.ok);
if (!latest.ok) process.exit(1);
console.log("5) default taskId ->", latest.task.command);

// 6) 未知 id
const unknown = await hub.output({ taskId: "nope", conversationId: CONV });
assert(!unknown.ok);
console.log("6) unknown:", (!unknown.ok ? unknown.error : "").slice(0, 50));

// 7) 通知流覆盖：start/progress/done 均有事件
const kinds = new Set(notices.map((n) => n.kind));
console.log("7) notice kinds:", [...kinds].join(","));
assert(kinds.has("start") && kinds.has("done"), "notice coverage");

console.log("\nALL SMOKE TESTS PASSED");
