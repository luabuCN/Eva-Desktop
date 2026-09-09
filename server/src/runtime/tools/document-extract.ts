import fs from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import JSZip from "jszip";

/**
 * 常见文档附件的文本提取：PDF（pdf-parse）与 OOXML 家族（docx/xlsx/pptx，
 * ZIP + XML，用 jszip 解包后按结构抽取）。readFile 在遇到这些扩展名时优
 * 先走这里，模型即可像读普通文本一样读取文档附件的内容。
 */

const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx"]);

/** 知识库文档上传额外接受的纯文本/标记格式。 */
const TEXT_DOCUMENT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".html", ".htm",
]);

/** 提取输出的软上限：防止超大文档撑爆工具输出与上下文。 */
const MAX_EXTRACT_CHARS = 400_000;

export function isDocumentPath(filePath: string): boolean {
  return DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export interface ExtractedDocument {
  /** 提取出的纯文本（已按软上限截断）。 */
  text: string;
  /** 截断标记，便于调用方在返回里带上提示。 */
  truncated: boolean;
}

export async function extractDocumentText(filePath: string): Promise<ExtractedDocument> {
  const bytes = await fs.readFile(filePath);
  return extractDocumentTextFromBytes(bytes, filePath);
}

/**
 * 上传文档的统一提取入口（知识库 Ingest 用）：md/markdown/txt 原样、
 * html/htm 剥离标签、pdf/docx/xlsx/pptx 走结构化提取。
 * 不支持的扩展名抛错，由调用方给出明确提示。
 */
export async function extractDocumentTextFromBytes(
  bytes: Buffer,
  filename: string,
): Promise<ExtractedDocument> {
  const extension = path.extname(filename).toLowerCase();
  let text: string;
  if (extension === ".pdf") {
    text = await extractPdf(bytes);
  } else if (DOCUMENT_EXTENSIONS.has(extension)) {
    text = await extractOoxml(bytes, extension);
  } else if (TEXT_DOCUMENT_EXTENSIONS.has(extension)) {
    text = extension === ".html" || extension === ".htm"
      ? extractHtml(bytes.toString("utf8"))
      : bytes.toString("utf8");
  } else {
    throw new Error(
      `不支持的文档类型 ${extension || "(无扩展名)"}：支持 md / txt / html / pdf / docx / xlsx / pptx`,
    );
  }
  const trimmed = text.replace(/\n{3,}/g, "\n\n").trim();
  const truncated = trimmed.length > MAX_EXTRACT_CHARS;
  return {
    text: truncated ? `${trimmed.slice(0, MAX_EXTRACT_CHARS)}\n…（内容过长，已截断）` : trimmed,
    truncated,
  };
}

/** HTML → 纯文本：丢 script/style/head 噪声，块级标签转换行，解码实体。 */
function extractHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/[ \t]+\n/g, "\n");
}

async function extractPdf(bytes: Buffer): Promise<string> {
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    return result.text ?? "";
  } finally {
    await parser.destroy();
  }
}

async function extractOoxml(bytes: Buffer, extension: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  if (extension === ".docx") return extractDocx(zip);
  if (extension === ".xlsx") return extractXlsx(zip);
  return extractPptx(zip);
}

// ---------------------------------------------------------------------------
// docx：word/document.xml 中 <w:p> 为段落、<w:t> 为文本片段。
// ---------------------------------------------------------------------------

async function extractDocx(zip: JSZip): Promise<string> {
  const entry = zip.file("word/document.xml");
  if (!entry) return "";
  const xml = await entry.async("string");
  const paragraphs = xml.split(/<\/w:p>/).map((chunk) => {
    const texts = [...chunk.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(
      (match) => decodeXmlEntities(match[1] ?? ""),
    );
    return texts.join("");
  });
  return paragraphs.filter((line) => line.trim().length > 0).join("\n");
}

// ---------------------------------------------------------------------------
// xlsx：sharedStrings.xml 提供共享字符串，worksheets/sheetN.xml 里 t="s" 的
// <v> 是其下标。按单元格引用（A1 式）对齐成制表符分隔的行。
// ---------------------------------------------------------------------------

async function extractXlsx(zip: JSZip): Promise<string> {
  const shared: string[] = [];
  const sharedEntry = zip.file("xl/sharedStrings.xml");
  if (sharedEntry) {
    const xml = await sharedEntry.async("string");
    for (const item of xml.split(/<\/si>/)) {
      const texts = [...item.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map(
        (match) => decodeXmlEntities(match[1] ?? ""),
      );
      shared.push(texts.join(""));
    }
  }

  const sheetNames = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => sheetOrdinal(a) - sheetOrdinal(b));
  const chunks: string[] = [];
  for (const sheetName of sheetNames) {
    const xml = await zip.file(sheetName)!.async("string");
    const lines: string[] = [];
    for (const rowChunk of xml.split(/<\/row>/)) {
      const cells = new Map<number, string>();
      for (const match of rowChunk.matchAll(
        /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g,
      )) {
        const attrs = match[1] ?? match[3] ?? "";
        const body = match[2] ?? "";
        const reference = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
        if (!reference) continue;
        const value = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        const inline = /<t(?:\s[^>]*)?>([^<]*)<\/t>/.exec(body)?.[1];
        const isShared = /t="s"/.test(attrs);
        let cell = "";
        if (isShared && value !== undefined) {
          cell = shared[Number(value)] ?? "";
        } else if (inline !== undefined) {
          cell = decodeXmlEntities(inline);
        } else if (value !== undefined) {
          cell = decodeXmlEntities(value);
        }
        cells.set(columnIndex(reference), cell);
      }
      if (cells.size === 0) continue;
      const width = Math.max(...cells.keys()) + 1;
      const line = Array.from({ length: width }, (_, index) => cells.get(index) ?? "").join("\t");
      if (line.trim().length > 0) lines.push(line);
    }
    if (lines.length > 0) chunks.push(`=== ${path.basename(sheetName, ".xml")} ===\n${lines.join("\n")}`);
  }
  return chunks.join("\n\n");
}

function sheetOrdinal(sheetName: string): number {
  return Number(/sheet(\d+)\.xml$/.exec(sheetName)?.[1] ?? 0);
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

// ---------------------------------------------------------------------------
// pptx：ppt/slides/slideN.xml 中 <a:t> 为文本片段。
// ---------------------------------------------------------------------------

async function extractPptx(zip: JSZip): Promise<string> {
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideOrdinal(a) - slideOrdinal(b));
  const chunks: string[] = [];
  for (const slideName of slideNames) {
    const xml = await zip.file(slideName)!.async("string");
    const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) =>
      decodeXmlEntities(match[1] ?? ""),
    );
    const merged = texts.filter((text) => text.trim().length > 0).join("\n");
    if (merged) chunks.push(`=== ${path.basename(slideName, ".xml")} ===\n${merged}`);
  }
  return chunks.join("\n\n");
}

function slideOrdinal(slideName: string): number {
  return Number(/slide(\d+)\.xml$/.exec(slideName)?.[1] ?? 0);
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&(amp|lt|gt|quot|apos);/g, (match) => XML_ENTITIES[match] ?? match)
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number(dec)));
}
