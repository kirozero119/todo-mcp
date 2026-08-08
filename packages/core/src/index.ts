/**
 * @todo-mcp/core の公開面。
 *
 * ここにあるのは MCP サーバー（packages/server）と CLI（チケット 11）が
 * 共有するもの——ドメインの語彙、Task の形、Turso 接続、tasks への SQL、
 * 時刻の扱い——だけ。ツール定義・description・行形式の整形・エラー文は
 * 入れない。それらは「誰に読ませるか」が front-end ごとに違う（AI 向けの
 * 中間表現と、人間が端末で読む表示）ので、共有すると両方が歪む。
 */
export { createTaskDb, type TaskDb, type TursoConfig } from "./db";
export {
  isClosedStatus,
  OPEN_STATUSES,
  STATUSES,
  statusSchema,
  taskFromRow,
  WORKSPACES,
  workspaceSchema,
  type Status,
  type Task,
  type TaskField,
  type Workspace,
} from "./schema";
export {
  completeTask,
  createTask,
  getTask,
  importTask,
  listOpenTaskIds,
  listOpenTasks,
  searchTasks,
  updateTask,
  type CompleteTaskOutcome,
  type CompleteTaskResult,
  type CreateTaskInput,
  type ImportTaskInput,
  type SearchTasksParams,
  type SearchTasksResult,
  type UpdateTaskInput,
  type UpdateTaskResult,
  type UserScope,
} from "./tasks";
export { isCalendarDate, jstDateOffset, nowIso, todayInJst, weekdayIndex } from "./time";
