import type { Task, TaskField, Workspace } from "@todo-mcp/core";

export function formatTask(task: Task): string {
  const project = task.project ? ` [${task.project}]` : "";
  const due = task.due ? ` (期限: ${task.due})` : "";
  const memo = task.memo ? " +memo" : "";
  return `  ${task.id}. [${task.status}] ${task.title}${project}${due}${memo}`;
}

export function formatList(
  workspace: Workspace,
  tasks: Task[],
  total: number,
  limit: number,
): string[] {
  if (total === 0) return [`${workspace}: タスクはありません`];
  const lines = [`${workspace}: ${total}件`, ...tasks.map(formatTask)];
  if (total > limit) lines.push(`  …残り ${total - limit} 件（条件を絞ってください）`);
  return lines;
}

export function changedLabel(changed: TaskField[]): string {
  return changed.length === 0 ? "変更なし" : changed.join(", ");
}
