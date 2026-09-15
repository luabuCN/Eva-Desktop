import { useEffect, useMemo, useState } from "react";
import { CircleHelpIcon, InfoIcon } from "lucide-react";
import type { AskUserInfo } from "@/api";
import { cn } from "@/lib/utils";

const CUSTOM_OPTION = "__custom__";

interface DraftAnswer {
  values: string[];
  customSelected: boolean;
  customText: string;
  skipped: boolean;
}

function emptyDrafts(count: number): DraftAnswer[] {
  return Array.from({ length: count }, () => ({
    values: [],
    customSelected: false,
    customText: "",
    skipped: false,
  }));
}

/** 从草稿里取有效答案：勾了“其他”但没填字视为未答。 */
function selectedValues(draft: DraftAnswer): string[] {
  const custom = draft.customSelected && draft.customText.trim()
    ? [draft.customText.trim()]
    : [];
  return [...draft.values, ...custom];
}

export interface AskUserPromptProps {
  ask: AskUserInfo;
  onSubmit: (answers: Array<string[] | null>) => void;
}

/** askUser 工具的交互卡片：一次只展示一题，选项点选、可跳过、可放弃整组。 */
export function AskUserPrompt({ ask, onSubmit }: AskUserPromptProps) {
  // 防御：questions 缺失或不是数组（如旧负载/脏数据）时不渲染卡片，
  // 避免下面的取值把整页打崩。
  const questions = Array.isArray(ask.questions) ? ask.questions : [];
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<DraftAnswer[]>(() => emptyDrafts(questions.length));
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setIndex(0);
    setDrafts(emptyDrafts(questions.length));
    setSubmitting(false);
  }, [ask.id, questions.length]);

  const statuses = useMemo(
    () =>
      drafts.map((draft) =>
        draft.skipped
          ? ("skipped" as const)
          : selectedValues(draft).length > 0
            ? ("answered" as const)
            : ("unanswered" as const),
      ),
    [drafts],
  );

  if (questions.length === 0) return null;

  const current = questions[index] ?? questions[questions.length - 1];
  const currentDraft = drafts[index] ?? {
    values: [],
    customSelected: false,
    customText: "",
    skipped: false,
  };

  const updateDraft = (update: (draft: DraftAnswer) => DraftAnswer) => {
    setDrafts((previous) =>
      previous.map((draft, draftIndex) => (draftIndex === index ? update(draft) : draft)),
    );
  };

  const selectOption = (option: string) => {
    updateDraft((draft) => {
      if (option === CUSTOM_OPTION) {
        return {
          ...draft,
          customSelected: !draft.customSelected,
          skipped: false,
          ...(current.multiSelect ? {} : { values: [] }),
        };
      }
      if (current.multiSelect) {
        return {
          ...draft,
          values: draft.values.includes(option)
            ? draft.values.filter((value) => value !== option)
            : [...draft.values, option],
          skipped: false,
        };
      }
      return { ...draft, values: [option], customSelected: false, customText: "", skipped: false };
    });
  };

  const answersOf = (nextDrafts: DraftAnswer[]): Array<string[] | null> =>
    nextDrafts.map((draft) => {
      const values = selectedValues(draft);
      return values.length > 0 && !draft.skipped ? values : null;
    });

  const submit = (nextDrafts: DraftAnswer[]) => {
    if (submitting) return;
    setSubmitting(true);
    onSubmit(answersOf(nextDrafts));
  };

  const advance = (markSkipped: boolean) => {
    const nextDrafts = drafts.map((draft, draftIndex) => {
      if (draftIndex !== index) return draft;
      if (!markSkipped && selectedValues(draft).length > 0) return { ...draft, skipped: false };
      return { ...draft, skipped: true, values: [], customSelected: false };
    });
    setDrafts(nextDrafts);
    if (index === questions.length - 1) submit(nextDrafts);
    else setIndex((value) => value + 1);
  };

  const declineAll = () => {
    if (submitting) return;
    setSubmitting(true);
    onSubmit(questions.map(() => null));
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      advance(false);
      return;
    }
    const numeric = Number.parseInt(event.key, 10);
    if (numeric >= 1 && numeric <= current.options.length) {
      event.preventDefault();
      selectOption(current.options[numeric - 1]);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm">
      <div className="flex items-center gap-2 px-4 pt-3 text-sm font-medium">
        <CircleHelpIcon className="size-4 shrink-0 text-primary" />
        <span>需要你回答几个问题</span>
        <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">
          第 {index + 1} / {questions.length} 题
        </span>
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-0.5 text-xs font-normal text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          disabled={submitting}
          onClick={declineAll}
        >
          全部跳过
        </button>
      </div>

      <div className="flex items-center gap-1.5 px-4 pt-2" aria-label="答题进度">
        {statuses.map((status, statusIndex) => (
          <button
            key={statusIndex}
            type="button"
            aria-label={`第 ${statusIndex + 1} 题：${
              status === "answered" ? "已回答" : status === "skipped" ? "已跳过" : "未回答"
            }`}
            aria-current={statusIndex === index ? "step" : undefined}
            onClick={() => setIndex(statusIndex)}
            className={cn(
              "h-1.5 rounded-full transition-all",
              statusIndex === index ? "w-5 bg-primary" : "w-3 bg-muted-foreground/30",
              statusIndex !== index && status === "answered" && "bg-primary/60",
              statusIndex !== index && status === "skipped" && "bg-muted-foreground/50",
            )}
          />
        ))}
      </div>

      <div tabIndex={0} onKeyDown={handleKeyDown} className="px-4 pb-1 pt-3 outline-none">
        <h3 className="text-sm font-medium leading-relaxed">{current.question}</h3>

        <div role={current.multiSelect ? "group" : "radiogroup"} className="mt-2.5 space-y-1.5">
          {current.options.map((option, optionIndex) => {
            const selected = currentDraft.values.includes(option);
            return (
              <button
                key={option}
                type="button"
                role={current.multiSelect ? "checkbox" : "radio"}
                aria-checked={selected}
                onClick={() => selectOption(option)}
                disabled={submitting}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                  selected
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border hover:bg-accent",
                )}
              >
                <span className="w-3 shrink-0 pt-0.5 text-xs text-muted-foreground">
                  {optionIndex + 1}.
                </span>
                <span className="min-w-0 flex-1 break-words">{option}</span>
                {selected ? <span className="shrink-0 text-primary">✓</span> : null}
              </button>
            );
          })}
          <button
            type="button"
            role={current.multiSelect ? "checkbox" : "radio"}
            aria-checked={currentDraft.customSelected}
            onClick={() => selectOption(CUSTOM_OPTION)}
            disabled={submitting}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
              currentDraft.customSelected
                ? "border-primary/60 bg-primary/10 text-foreground"
                : "border-border hover:bg-accent",
            )}
          >
            <span className="shrink-0 text-primary">✎</span>
            <span className="min-w-0 flex-1">其他（自行输入）</span>
            {currentDraft.customSelected ? (
              <span className="shrink-0 text-primary">✓</span>
            ) : null}
          </button>
        </div>

        {currentDraft.customSelected ? (
          <input
            className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            placeholder="输入你的回答…"
            autoFocus
            value={currentDraft.customText}
            onChange={(event) =>
              updateDraft((draft) => ({
                ...draft,
                customText: event.target.value,
                skipped: false,
              }))
            }
            disabled={submitting}
          />
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-2 px-4 pb-3 pt-1">
        <button
          type="button"
          className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          disabled={submitting}
          onClick={() => advance(true)}
        >
          跳过此题
        </button>
        <button
          type="button"
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          disabled={submitting}
          onClick={() => advance(false)}
        >
          {index === questions.length - 1 ? "提交" : "下一题"}
        </button>
      </div>

      <div className="flex items-center gap-1.5 border-t px-3.5 py-1.5 text-xs text-muted-foreground">
        <InfoIcon className="size-3.5 shrink-0" />
        <span>
          数字键选择选项，回车{index === questions.length - 1 ? "提交" : "进入下一题"}
          {current.multiSelect ? "；此题可多选" : ""}
        </span>
      </div>
    </div>
  );
}
