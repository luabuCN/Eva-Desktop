import "./env.js";
import { PrismaClient } from "@prisma/client";
import { builtInAgentRows } from "./runtime/agent-defaults.js";
import { subAgentService } from "./runtime/subagents.js";

export const prisma = new PrismaClient();

export async function ensureSchema() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Conversation" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "title" TEXT NOT NULL DEFAULT 'New chat',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "StoredMessage" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "conversationId" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "sequence" INTEGER NOT NULL,
      "role" TEXT NOT NULL,
      "payload" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "StoredMessage_conversationId_fkey"
        FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "StoredMessage_conversationId_kind_sequence_key" ON "StoredMessage" ("conversationId", "kind", "sequence")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "StoredMessage_conversationId_kind_sequence_idx" ON "StoredMessage" ("conversationId", "kind", "sequence")',
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Provider" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "apiBase" TEXT NOT NULL,
      "apiKey" TEXT,
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "models" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "Provider_name_key" ON "Provider" ("name")',
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AppSetting" (
      "key" TEXT NOT NULL PRIMARY KEY,
      "value" TEXT NOT NULL,
      "updatedAt" DATETIME NOT NULL
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "rootPath" TEXT NOT NULL,
      "description" TEXT,
      "defaultAgentId" TEXT,
      "defaultProviderId" TEXT,
      "defaultModelId" TEXT,
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "Project_name_key" ON "Project" ("name")',
  );
  await addColumnIfMissing(`
    ALTER TABLE "Project" ADD COLUMN "defaultProviderId" TEXT
  `);
  await addColumnIfMissing(`
    ALTER TABLE "Conversation" ADD COLUMN "projectId" TEXT
      REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE
  `);
  await addColumnIfMissing(`
    ALTER TABLE "Conversation" ADD COLUMN "titleLocked" BOOLEAN NOT NULL DEFAULT false
  `);
  await addColumnIfMissing(`
    ALTER TABLE "Conversation" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false
  `);
  await addColumnIfMissing(`
    ALTER TABLE "Conversation" ADD COLUMN "archivedAt" DATETIME
  `);
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "Conversation_projectId_idx" ON "Conversation" ("projectId")',
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ThreadRun" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "conversationId" TEXT NOT NULL,
      "projectId" TEXT,
      "agentId" TEXT,
      "thinkingMode" TEXT NOT NULL DEFAULT 'fast',
      "permissionMode" TEXT NOT NULL DEFAULT 'confirm',
      "providerId" TEXT,
      "modelId" TEXT,
      "status" TEXT NOT NULL DEFAULT 'queued',
      "error" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "startedAt" DATETIME,
      "completedAt" DATETIME,
      CONSTRAINT "ThreadRun_conversationId_fkey"
        FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "ThreadRun_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "Project"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "ThreadRun_conversationId_status_createdAt_idx" ON "ThreadRun" ("conversationId", "status", "createdAt")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "ThreadRun_projectId_createdAt_idx" ON "ThreadRun" ("projectId", "createdAt")',
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "RunEvent" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "runId" TEXT NOT NULL,
      "sequence" INTEGER NOT NULL,
      "eventType" TEXT NOT NULL,
      "payload" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "RunEvent_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "ThreadRun"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "RunEvent_runId_sequence_key" ON "RunEvent" ("runId", "sequence")',
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ToolApproval" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "runId" TEXT NOT NULL,
      "toolName" TEXT NOT NULL,
      "input" TEXT NOT NULL,
      "reason" TEXT,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "decisionBy" TEXT,
      "decidedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ToolApproval_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "ThreadRun"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "ToolApproval_runId_status_idx" ON "ToolApproval" ("runId", "status")',
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AskUserPrompt" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "runId" TEXT NOT NULL,
      "questions" TEXT NOT NULL,
      "answers" TEXT,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "AskUserPrompt_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "ThreadRun"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "AskUserPrompt_runId_status_idx" ON "AskUserPrompt" ("runId", "status")',
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AgentTask" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "conversationId" TEXT NOT NULL,
      "runId" TEXT,
      "taskId" INTEGER NOT NULL,
      "subject" TEXT NOT NULL,
      "description" TEXT,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "activeForm" TEXT,
      "owner" TEXT,
      "metadata" TEXT,
      "blockedBy" TEXT,
      "blocks" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "AgentTask_conversationId_fkey"
        FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "AgentTask_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "ThreadRun"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "AgentTask_conversationId_taskId_key" ON "AgentTask" ("conversationId", "taskId")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "AgentTask_conversationId_status_taskId_idx" ON "AgentTask" ("conversationId", "status", "taskId")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "AgentTask_runId_idx" ON "AgentTask" ("runId")',
  );

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AgentConfig" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL,
      "instructions" TEXT NOT NULL,
      "toolPermissions" TEXT NOT NULL,
      "readOnly" BOOLEAN NOT NULL DEFAULT false,
      "subAgents" TEXT NOT NULL,
      "defaultProviderId" TEXT,
      "defaultModelId" TEXT,
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "AgentConfig_name_key" ON "AgentConfig" ("name")',
  );
  await addColumnIfMissing(`
    ALTER TABLE "AgentConfig" ADD COLUMN "readOnly" BOOLEAN NOT NULL DEFAULT false
  `);
  await addColumnIfMissing(`
    ALTER TABLE "ThreadRun" ADD COLUMN "permissionMode" TEXT NOT NULL DEFAULT 'confirm'
  `);
  await addColumnIfMissing(`
    ALTER TABLE "Project" ADD COLUMN "toolPermissions" TEXT
  `);
  await addColumnIfMissing(`
    ALTER TABLE "Project" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false
  `);
  await addColumnIfMissing(`
    ALTER TABLE "Project" ADD COLUMN "archivedAt" DATETIME
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ToolRecord" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "label" TEXT NOT NULL,
      "description" TEXT NOT NULL,
      "risk" TEXT NOT NULL DEFAULT 'medium',
      "mutating" BOOLEAN NOT NULL DEFAULT false,
      "providerId" TEXT NOT NULL DEFAULT 'builtin',
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "config" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "ToolRecord_providerId_idx" ON "ToolRecord" ("providerId")',
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "FileChange" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "runId" TEXT,
      "conversationId" TEXT NOT NULL,
      "projectId" TEXT,
      "path" TEXT NOT NULL,
      "changeKind" TEXT NOT NULL,
      "before" TEXT,
      "after" TEXT,
      "unifiedDiff" TEXT,
      "additions" INTEGER NOT NULL DEFAULT 0,
      "deletions" INTEGER NOT NULL DEFAULT 0,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "FileChange_conversationId_fkey"
        FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "FileChange_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "ThreadRun"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "FileChange_conversationId_createdAt_idx" ON "FileChange" ("conversationId", "createdAt")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "FileChange_projectId_createdAt_idx" ON "FileChange" ("projectId", "createdAt")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "FileChange_runId_idx" ON "FileChange" ("runId")',
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "SubAgentDefinition" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL,
      "tools" TEXT NOT NULL,
      "prompt" TEXT NOT NULL,
      "providerId" TEXT,
      "modelId" TEXT,
      "maxTurns" INTEGER,
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "SubAgentDefinition_name_key" ON "SubAgentDefinition" ("name")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "SubAgentDefinition_isActive_idx" ON "SubAgentDefinition" ("isActive")',
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "SkillRecord" (
      "key" TEXT NOT NULL PRIMARY KEY,
      "source" TEXT NOT NULL,
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "SkillRecord_source_idx" ON "SkillRecord" ("source")',
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "CronJob" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "prompt" TEXT NOT NULL,
      "cron" TEXT NOT NULL,
      "description" TEXT,
      "projectId" TEXT,
      "agentId" TEXT,
      "permissionMode" TEXT NOT NULL DEFAULT 'confirm',
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "reuseThread" BOOLEAN NOT NULL DEFAULT false,
      "lastRunAt" DATETIME,
      "lastRunEndAt" DATETIME,
      "lastRunStatus" TEXT,
      "lastRunError" TEXT,
      "lastRunConversationId" TEXT,
      "runHistory" TEXT NOT NULL DEFAULT '[]',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "CronJob_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "Project"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "CronJob_name_key" ON "CronJob" ("name")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "CronJob_isActive_idx" ON "CronJob" ("isActive")',
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "McpServer" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "label" TEXT NOT NULL,
      "description" TEXT,
      "transport" TEXT NOT NULL,
      "command" TEXT,
      "args" TEXT NOT NULL DEFAULT '[]',
      "env" TEXT NOT NULL DEFAULT '{}',
      "url" TEXT,
      "headers" TEXT NOT NULL DEFAULT '{}',
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "projectId" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "McpServer_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "Project"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "McpServer_projectId_idx" ON "McpServer" ("projectId")',
  );

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "WikiPage" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "scopeId" TEXT NOT NULL,
      "path" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "content" TEXT NOT NULL,
      "meta" TEXT NOT NULL DEFAULT '{}',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "WikiPage_scopeId_path_key" ON "WikiPage" ("scopeId", "path")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "WikiPage_scopeId_type_idx" ON "WikiPage" ("scopeId", "type")',
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "WikiIngestJob" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "scopeId" TEXT NOT NULL,
      "conversationId" TEXT NOT NULL DEFAULT '',
      "projectId" TEXT,
      "fromSeq" INTEGER NOT NULL DEFAULT 0,
      "toSeq" INTEGER NOT NULL DEFAULT 0,
      "sourceKind" TEXT NOT NULL DEFAULT 'conversation',
      "payload" TEXT NOT NULL DEFAULT '{}',
      "trigger" TEXT NOT NULL DEFAULT 'auto',
      "status" TEXT NOT NULL DEFAULT 'queued',
      "error" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      "completedAt" DATETIME
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "WikiDocument" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "scopeId" TEXT NOT NULL,
      "filename" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "text" TEXT NOT NULL,
      "chars" INTEGER NOT NULL DEFAULT 0,
      "truncated" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "WikiDocument_scopeId_filename_key" ON "WikiDocument" ("scopeId", "filename")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "WikiDocument_scopeId_idx" ON "WikiDocument" ("scopeId")',
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "WikiPageRevision" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "scopeId" TEXT NOT NULL,
      "path" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "content" TEXT NOT NULL,
      "meta" TEXT NOT NULL DEFAULT '{}',
      "reason" TEXT NOT NULL DEFAULT 'manual',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "WikiPageRevision_scopeId_path_createdAt_idx" ON "WikiPageRevision" ("scopeId", "path", "createdAt")',
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "WikiChunk" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "scopeId" TEXT NOT NULL,
      "path" TEXT NOT NULL,
      "chunkIndex" INTEGER NOT NULL,
      "text" TEXT NOT NULL,
      "embedding" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "WikiChunk_scopeId_path_chunkIndex_key" ON "WikiChunk" ("scopeId", "path", "chunkIndex")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "WikiChunk_scopeId_idx" ON "WikiChunk" ("scopeId")',
  );
  await addColumnIfMissing(`
    ALTER TABLE "Project" ADD COLUMN "wikiAutoIngest" BOOLEAN
  `);
  await addColumnIfMissing(`
    ALTER TABLE "WikiIngestJob" ADD COLUMN "sourceKind" TEXT NOT NULL DEFAULT 'conversation'
  `);
  await addColumnIfMissing(`
    ALTER TABLE "WikiIngestJob" ADD COLUMN "payload" TEXT NOT NULL DEFAULT '{}'
  `);
  await addColumnIfMissing(`
    ALTER TABLE "WikiDocument" ADD COLUMN "hasFile" BOOLEAN NOT NULL DEFAULT false
  `);
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "WikiIngestJob_scopeId_status_createdAt_idx" ON "WikiIngestJob" ("scopeId", "status", "createdAt")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "WikiIngestJob_conversationId_idx" ON "WikiIngestJob" ("conversationId")',
  );

  for (const agent of builtInAgentRows()) {
    await prisma.agentConfig.upsert({
      where: { id: agent.id },
      create: { ...agent, isBuiltIn: true },
      update: {
        description: agent.description,
        instructions: agent.instructions,
        readOnly: agent.readOnly,
        subAgents: agent.subAgents,
        isBuiltIn: true,
      },
    });
  }
  await subAgentService.seedBuiltins();

  const staleStatuses = ["queued", "running", "waiting_approval"];
  await prisma.threadRun.updateMany({
    where: { status: { in: staleStatuses } },
    data: {
      status: "failed",
      error: "Interrupted by sidecar restart",
      completedAt: new Date(),
    },
  });
  // 服务重启遗留的 processing 总结任务回到队列，避免卡死整个串行队列。
  await prisma.wikiIngestJob.updateMany({
    where: { status: "processing" },
    data: { status: "queued" },
  });
}

async function addColumnIfMissing(statement: string) {
  try {
    await prisma.$executeRawUnsafe(statement);
  } catch (error) {
    // SQLite reports duplicate columns as raw driver errors rather than a
    // stable Prisma error code, so match on the driver's message.
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("duplicate column name")) throw error;
  }
}
