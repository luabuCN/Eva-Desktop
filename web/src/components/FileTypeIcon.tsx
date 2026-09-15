import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

/** 文件类型样式：label 为印在纸张中央的大字，color 为字色（直接印在白纸上，需足够深）。 */
interface FileTypeStyle {
  label: string;
  color: string;
}

/**
 * 常见文件类型 → 类型字标。配色对齐各类语言/格式的惯用品牌色并加深，
 * 保证白纸上可读；未命中的扩展名回退为无字标的灰边白纸（IDE 文件树风格）。
 * 标签尽量控制在 1~3 字符，越长字号越小。
 */
const FILE_TYPE_STYLES: Record<string, FileTypeStyle> = {
  // 文档
  md: { label: "MD", color: "#3B6EF3" },
  markdown: { label: "MD", color: "#3B6EF3" },
  pdf: { label: "PDF", color: "#D93025" },
  doc: { label: "W", color: "#2B579A" },
  docx: { label: "W", color: "#2B579A" },
  rtf: { label: "W", color: "#2B579A" },
  odt: { label: "W", color: "#2B579A" },
  txt: { label: "≡", color: "#64748B" },
  log: { label: "≡", color: "#64748B" },
  // 表格 / 幻灯片
  xls: { label: "X", color: "#217346" },
  xlsx: { label: "X", color: "#217346" },
  xlsm: { label: "X", color: "#217346" },
  csv: { label: "X", color: "#217346" },
  tsv: { label: "X", color: "#217346" },
  ppt: { label: "P", color: "#C43E1C" },
  pptx: { label: "P", color: "#C43E1C" },
  odp: { label: "P", color: "#C43E1C" },
  // 代码
  py: { label: "PY", color: "#3776AB" },
  pyw: { label: "PY", color: "#3776AB" },
  ipynb: { label: "NB", color: "#D9631B" },
  ts: { label: "TS", color: "#3178C6" },
  tsx: { label: "TSX", color: "#3178C6" },
  mts: { label: "TS", color: "#3178C6" },
  js: { label: "JS", color: "#BF8F00" },
  mjs: { label: "JS", color: "#BF8F00" },
  cjs: { label: "JS", color: "#BF8F00" },
  jsx: { label: "JSX", color: "#BF8F00" },
  json: { label: "{}", color: "#8E931F" },
  jsonc: { label: "{}", color: "#8E931F" },
  html: { label: "<>", color: "#E44D26" },
  htm: { label: "<>", color: "#E44D26" },
  css: { label: "#", color: "#1572B6" },
  scss: { label: "#", color: "#BF4F86" },
  sass: { label: "#", color: "#BF4F86" },
  less: { label: "#", color: "#2D5E91" },
  vue: { label: "V", color: "#2E8B5E" },
  svelte: { label: "S", color: "#E2482E" },
  rs: { label: "RS", color: "#C74E20" },
  go: { label: "GO", color: "#0087A8" },
  java: { label: "J", color: "#B07219" },
  kt: { label: "KT", color: "#7F52FF" },
  kts: { label: "KT", color: "#7F52FF" },
  c: { label: "C", color: "#647A8B" },
  h: { label: "H", color: "#647A8B" },
  cpp: { label: "C++", color: "#00599C" },
  cc: { label: "C++", color: "#00599C" },
  cxx: { label: "C++", color: "#00599C" },
  hpp: { label: "C++", color: "#00599C" },
  hh: { label: "C++", color: "#00599C" },
  cs: { label: "C#", color: "#68217A" },
  rb: { label: "RB", color: "#CC342D" },
  php: { label: "PHP", color: "#777BB4" },
  swift: { label: "SW", color: "#E0492F" },
  sh: { label: "SH", color: "#5C7480" },
  bash: { label: "SH", color: "#5C7480" },
  zsh: { label: "SH", color: "#5C7480" },
  ps1: { label: "PS", color: "#2E5D9E" },
  psm1: { label: "PS", color: "#2E5D9E" },
  sql: { label: "DB", color: "#B07500" },
  prisma: { label: "PR", color: "#5A67D8" },
  graphql: { label: "G", color: "#C2185B" },
  gql: { label: "G", color: "#C2185B" },
  // 配置
  yaml: { label: "Y", color: "#9A63C9" },
  yml: { label: "Y", color: "#9A63C9" },
  toml: { label: "T", color: "#C93834" },
  xml: { label: "XML", color: "#1F9D61" },
  iml: { label: "I", color: "#2E5D9E" },
  gitignore: { label: "GIT", color: "#F05033" },
  dockerignore: { label: "GIT", color: "#F05033" },
  env: { label: "E", color: "#6E9B3E" },
  editorconfig: { label: "EC", color: "#2E5D9E" },
  eslintrc: { label: "ES", color: "#4B32C3" },
  prettierrc: { label: "PR", color: "#B07D00" },
  lock: { label: "L", color: "#A16207" },
  // 媒体 / 压缩包
  png: { label: "IMG", color: "#8B5CF6" },
  jpg: { label: "IMG", color: "#8B5CF6" },
  jpeg: { label: "IMG", color: "#8B5CF6" },
  gif: { label: "IMG", color: "#8B5CF6" },
  webp: { label: "IMG", color: "#8B5CF6" },
  bmp: { label: "IMG", color: "#8B5CF6" },
  avif: { label: "IMG", color: "#8B5CF6" },
  ico: { label: "IMG", color: "#8B5CF6" },
  svg: { label: "SVG", color: "#C77E1F" },
  mp4: { label: "▶", color: "#DB2777" },
  webm: { label: "▶", color: "#DB2777" },
  mov: { label: "▶", color: "#DB2777" },
  mkv: { label: "▶", color: "#DB2777" },
  avi: { label: "▶", color: "#DB2777" },
  mp3: { label: "♪", color: "#0284C7" },
  wav: { label: "♪", color: "#0284C7" },
  flac: { label: "♪", color: "#0284C7" },
  ogg: { label: "♪", color: "#0284C7" },
  m4a: { label: "♪", color: "#0284C7" },
  zip: { label: "Z", color: "#A16207" },
  rar: { label: "Z", color: "#A16207" },
  "7z": { label: "Z", color: "#A16207" },
  tar: { label: "Z", color: "#A16207" },
  gz: { label: "Z", color: "#A16207" },
  tgz: { label: "Z", color: "#A16207" },
  bz2: { label: "Z", color: "#A16207" },
  xz: { label: "Z", color: "#A16207" },
};

/** 无扩展名的常见文件名特判。 */
const NAME_STYLES: Record<string, FileTypeStyle> = {
  dockerfile: { label: "DK", color: "#2496ED" },
  makefile: { label: "MK", color: "#57606F" },
  gemfile: { label: "GM", color: "#CC342D" },
};

/** 从文件名推断类型键：路径取末段；.env.local / .gitignore 等点开头文件按前缀归类。 */
export function fileTypeKey(name: string): string {
  const base = (name.replaceAll("\\", "/").split("/").pop() ?? name).toLowerCase();
  if (NAME_STYLES[base]) return base;
  if (base.startsWith(".env")) return "env";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1) : "";
}

export function fileTypeStyle(name: string): FileTypeStyle | null {
  return FILE_TYPE_STYLES[fileTypeKey(name)] ?? null;
}

/** 类型字标长度 → 字号（viewBox 16px 基准；字大优先，越长越小）。 */
const LABEL_FONT_SIZE = [0, 10.5, 6.8, 5.2, 4.6];

/** 按文件类型区分的文件图标：白纸 + 居中彩色类型大字（JetBrains/图一风格），
 * 未识别类型为灰边白纸。size 通过 className 控制（如 size-4）。 */
export function FileTypeIcon({
  name,
  className,
  ...props
}: { name: string } & SVGProps<SVGSVGElement>) {
  const style = fileTypeStyle(name);
  const chars = Math.min(style?.label.length ?? 0, 4);

  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={cn("shrink-0", className)}
      aria-hidden="true"
      {...props}
    >
      {/* 纸张主体 + 折角 */}
      <path
        d="M2.8 1.2H9L13.4 5.6V14.8H2.8Z"
        fill="#FFFFFF"
        stroke="#94A3B8"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path d="M9 1.2V5.6H13.4Z" fill="#DBE3EC" />
      {style ? (
        <text
          x={8.1}
          y={8.6}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={LABEL_FONT_SIZE[chars]}
          fontWeight={800}
          fill={style.color}
        >
          {style.label}
        </text>
      ) : null}
    </svg>
  );
}
