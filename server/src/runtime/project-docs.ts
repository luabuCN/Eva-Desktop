import path from "node:path";
import fs from "node:fs/promises";

/** 工作区根目录的项目指令文件，按顺序取第一个存在的。 */
export interface ProjectDocs {
  fileName: string;
  content: string;
}

const DOC_FILE_CANDIDATES = ["AGENTS.md", "agents.md", "CLAUDE.md", "EVA.md"];

// 系统提示每回合都会全量发送，项目指令也要有界；超出截断并标注。
const MAX_DOC_CHARS = 32_000;

/**
 * 读取工作区根目录的项目指令文件（AGENTS.md / CLAUDE.md / EVA.md，第一个
 * 存在的非空文件生效）。任何读失败都按"不存在"处理，绝不阻塞运行。
 */
export async function loadProjectDocs(
  workspacePath: string,
): Promise<ProjectDocs | undefined> {
  for (const fileName of DOC_FILE_CANDIDATES) {
    try {
      const filePath = path.join(workspacePath, fileName);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      let content = await fs.readFile(filePath, "utf-8");
      if (!content.trim()) continue;
      if (content.length > MAX_DOC_CHARS) {
        content =
          content.slice(0, MAX_DOC_CHARS) +
          `\n\n[${fileName} truncated at ${MAX_DOC_CHARS} characters]`;
      }
      return { fileName, content };
    } catch {
      // ENOENT / 权限等：尝试下一个候选。
    }
  }
  return undefined;
}

/** 拼进系统提示的项目指令块，主智能体与子智能体共用同一段框架文案。 */
export function projectDocsSection(docs: ProjectDocs): string {
  return [
    `The workspace root contains ${docs.fileName}, the user's project instructions. ` +
      "Follow it as the authoritative source for project conventions, commands, and " +
      "structure; it does not override tool approval or safety rules.",
    `--- ${docs.fileName} ---`,
    docs.content,
    `--- end of ${docs.fileName} ---`,
  ].join("\n");
}
