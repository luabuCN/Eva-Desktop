import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  createSkill,
  readSkillBody,
  updateSkill,
  type SkillInfo,
} from "@/api";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

interface SkillFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 新建；传入自定义技能 = 编辑内容。 */
  initial: SkillInfo | null;
  onSaved: () => void;
}

/** 自定义技能编辑器：名称/描述写入 front-matter，正文即 SKILL.md 主体。 */
export function SkillFormSheet({ open, onOpenChange, initial, onSaved }: SkillFormSheetProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    if (!initial) {
      setName("");
      setDescription("");
      setBody("");
      setEnabled(true);
      return;
    }
    // 编辑时正文在服务端，打开时异步载入。
    let cancelled = false;
    readSkillBody(initial.key)
      .then((doc) => {
        if (cancelled) return;
        setName(doc.name);
        setDescription(doc.description ?? "");
        setBody(doc.body);
        setEnabled(initial.enabled);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "读取技能失败");
      });
    return () => {
      cancelled = true;
    };
  }, [initial, open]);

  async function save() {
    if (!name.trim() || !body.trim()) {
      setError("名称和技能内容为必填项");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      if (initial) await updateSkill(initial.key, { name: name.trim(), description: description.trim(), body: body.trim(), enabled });
      else await createSkill({ name: name.trim(), description: description.trim(), body: body.trim() });
      onSaved();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{initial ? `编辑技能 ${initial.name}` : "创建技能"}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="skill-name">名称</FieldLabel>
              <Input
                id="skill-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如 pdf-export、代码评审"
              />
              <FieldDescription>
                小写化后作为输入框里的斜杠命令（/名称）；字母、数字、中文与短横线。
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="skill-description">描述</FieldLabel>
              <Textarea
                id="skill-description"
                className="min-h-16"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="一句话说明这个技能做什么、什么情况下使用；模型靠它决定何时加载。"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="skill-body">技能内容（Markdown 指令）</FieldLabel>
              <Textarea
                id="skill-body"
                className="min-h-72 font-mono text-xs"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder={"# 指令正文\n\n告诉模型完成这类任务的具体步骤、约束与输出格式。"}
              />
              <FieldDescription>
                保存为应用技能目录下的 SKILL.md；发送消息时可用「/名称」显式调用，模型也可按描述自动加载。
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>启用</FieldLabel>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </Field>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </FieldGroup>
        </div>

        <DialogFooter className="mt-0 gap-2">
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
