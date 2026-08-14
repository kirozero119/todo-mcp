import {
  createTask,
  deleteTask,
  searchTasks,
  updateTask,
  type TaskDb,
  type Workspace,
} from "@todo-mcp/core";

import type { Command } from "./args.ts";
import type { CliConfig } from "./config.ts";
import { changedLabel, formatList, formatTask } from "./format.ts";

const LIST_LIMIT = 100;

export interface ExecuteDeps {
  db: TaskDb;
  config: Pick<CliConfig, "userId" | "defaultWorkspace">;
}

function workspaceFor(
  commandWorkspace: Workspace | undefined,
  config: ExecuteDeps["config"],
): Workspace {
  return commandWorkspace ?? config.defaultWorkspace;
}

/** CLI の interface の裏側。I/O を返り値に寄せ、テストも実行時も同じ seam を通す。 */
export async function executeCommand(
  command: Exclude<Command, { kind: "help" }>,
  deps: ExecuteDeps,
): Promise<string[]> {
  const { db, config } = deps;

  switch (command.kind) {
    case "add": {
      const task = await createTask(db, {
        userId: config.userId,
        workspace: workspaceFor(command.workspace, config),
        title: command.title,
        project: command.project,
        due: command.due,
        memo: command.memo,
      });
      return [`追加しました: ${formatTask(task).trim()}`];
    }
    case "list": {
      const workspace = workspaceFor(command.workspace, config);
      const result = await searchTasks(db, {
        userId: config.userId,
        workspace,
        status: command.status,
        project: command.project,
        query: command.query,
        includeClosed: command.includeClosed,
        limit: LIST_LIMIT,
      });
      return formatList(workspace, result.tasks, result.total, LIST_LIMIT);
    }
    case "status": {
      const result = await updateTask(db, {
        userId: config.userId,
        id: command.id,
        status: command.status,
        memo: command.memo,
      });
      if (!result) return [`タスクID ${command.id} が見つかりません`];
      const lines = [
        `更新しました: ${formatTask(result.task).trim()}（${changedLabel(result.changed)}）`,
      ];
      if (command.status === "waiting" && command.memo === undefined && !result.task.memo) {
        lines.push("ヒント: --memo に待っている相手・返答を残すと追跡しやすくなります");
      }
      return lines;
    }
    case "edit": {
      const result = await updateTask(db, {
        userId: config.userId,
        id: command.id,
        title: command.title,
        workspace: command.workspace,
        project: command.project,
        due: command.due,
        memo: command.memo,
      });
      if (!result) return [`タスクID ${command.id} が見つかりません`];
      return [`更新しました: ${formatTask(result.task).trim()}（${changedLabel(result.changed)}）`];
    }
    case "delete": {
      const task = await deleteTask(db, { userId: config.userId, id: command.id });
      return task
        ? [`物理削除しました: ${formatTask(task).trim()}`]
        : [`タスクID ${command.id} が見つかりません`];
    }
  }
}
