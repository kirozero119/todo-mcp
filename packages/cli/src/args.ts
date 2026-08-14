import {
  isCalendarDate,
  statusSchema,
  workspaceSchema,
  type Status,
  type Workspace,
} from "@todo-mcp/core";

export type Command =
  | { kind: "help" }
  | {
      kind: "add";
      title: string;
      workspace?: Workspace;
      project?: string;
      due?: string;
      memo?: string;
    }
  | {
      kind: "list";
      workspace?: Workspace;
      status?: Status;
      project?: string;
      query?: string;
      includeClosed: boolean;
    }
  | { kind: "status"; id: number; status: Status; memo?: string }
  | {
      kind: "edit";
      id: number;
      title?: string;
      workspace?: Workspace;
      project?: string | null;
      due?: string | null;
      memo?: string | null;
    }
  | { kind: "delete"; id: number };

export class UsageError extends Error {}

export const USAGE = `使い方:
  todo add <title> [--workspace work|life] [--project P] [--due YYYY-MM-DD] [--memo M]
  todo list [--workspace work|life] [--status STATUS] [--project P] [--query Q] [--all]
  todo status <id> <STATUS> [--memo M]
  todo edit <id> [--title T] [--workspace work|life] [--project P|--clear-project]
                 [--due YYYY-MM-DD|--clear-due] [--memo M|--clear-memo]
  todo delete <id>

STATUS: todo / in_progress / waiting / someday / done / cancelled
互換性: --category は --project の旧名として引き続き使える`;

function positiveId(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value) || Number(value) < 1) {
    throw new UsageError(`id は 1 以上の整数（受け取った値: ${JSON.stringify(value)}）`);
  }
  return Number(value);
}

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} には値が要る`);
  }
  return value;
}

function parseWorkspace(value: string, flag = "--workspace"): Workspace {
  const parsed = workspaceSchema.safeParse(value);
  if (!parsed.success) throw new UsageError(`${flag} は work か life`);
  return parsed.data;
}

function parseStatus(value: string | undefined): Status {
  const parsed = statusSchema.safeParse(value);
  if (!parsed.success) {
    throw new UsageError(
      "status は todo / in_progress / waiting / someday / done / cancelled のいずれか",
    );
  }
  return parsed.data;
}

function setProject(current: string | undefined, value: string, flag: string): string {
  if (current !== undefined) {
    throw new UsageError(`--project と --category は同時に指定できない（重複: ${flag}）`);
  }
  return value;
}

export function parseArgs(argv: string[]): Command {
  const [name, ...rest] = argv;
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    return { kind: "help" };
  }

  if (name === "add") {
    const title = rest[0];
    if (!title || title.startsWith("--") || title.trim() === "") {
      throw new UsageError("add には空でない title が要る");
    }
    const command: Extract<Command, { kind: "add" }> = { kind: "add", title };
    for (let i = 1; i < rest.length; i += 1) {
      const flag = rest[i];
      switch (flag) {
        case "--workspace":
          command.workspace = parseWorkspace(valueAfter(rest, i, flag));
          i += 1;
          break;
        case "--project":
        case "--category":
          command.project = setProject(command.project, valueAfter(rest, i, flag), flag);
          if (command.project === "") throw new UsageError(`${flag} は空にできない`);
          i += 1;
          break;
        case "--due": {
          const due = valueAfter(rest, i, flag);
          if (!isCalendarDate(due)) throw new UsageError("--due は YYYY-MM-DD の実在日");
          command.due = due;
          i += 1;
          break;
        }
        case "--memo":
          command.memo = valueAfter(rest, i, flag);
          i += 1;
          break;
        default:
          throw new UsageError(`add の知らない引数: ${JSON.stringify(flag)}`);
      }
    }
    return command;
  }

  if (name === "list") {
    const command: Extract<Command, { kind: "list" }> = {
      kind: "list",
      includeClosed: false,
    };
    for (let i = 0; i < rest.length; i += 1) {
      const flag = rest[i];
      switch (flag) {
        case "--workspace":
          command.workspace = parseWorkspace(valueAfter(rest, i, flag));
          i += 1;
          break;
        case "--status":
          command.status = parseStatus(valueAfter(rest, i, flag));
          i += 1;
          break;
        case "--project":
        case "--category":
          command.project = setProject(command.project, valueAfter(rest, i, flag), flag);
          if (command.project === "") throw new UsageError(`${flag} は空にできない`);
          i += 1;
          break;
        case "--query":
          command.query = valueAfter(rest, i, flag);
          if (command.query === "") throw new UsageError("--query は空にできない");
          i += 1;
          break;
        case "--all":
          command.includeClosed = true;
          break;
        default:
          throw new UsageError(`list の知らない引数: ${JSON.stringify(flag)}`);
      }
    }
    return command;
  }

  if (name === "status") {
    const id = positiveId(rest[0]);
    const status = parseStatus(rest[1]);
    let memo: string | undefined;
    for (let i = 2; i < rest.length; i += 1) {
      const flag = rest[i];
      if (flag !== "--memo") throw new UsageError(`status の知らない引数: ${flag}`);
      memo = valueAfter(rest, i, flag);
      i += 1;
    }
    return { kind: "status", id, status, memo };
  }

  if (name === "edit") {
    const command: Extract<Command, { kind: "edit" }> = { kind: "edit", id: positiveId(rest[0]) };
    for (let i = 1; i < rest.length; i += 1) {
      const flag = rest[i];
      switch (flag) {
        case "--title":
          command.title = valueAfter(rest, i, flag);
          if (command.title.trim() === "") throw new UsageError("--title は空にできない");
          i += 1;
          break;
        case "--workspace":
          command.workspace = parseWorkspace(valueAfter(rest, i, flag));
          i += 1;
          break;
        case "--project":
        case "--category":
          if (command.project !== undefined) throw new UsageError("project の変更指定が重複している");
          command.project = valueAfter(rest, i, flag);
          i += 1;
          break;
        case "--clear-project":
          if (command.project !== undefined) throw new UsageError("project の変更指定が重複している");
          command.project = null;
          break;
        case "--due": {
          if (command.due !== undefined) throw new UsageError("due の変更指定が重複している");
          const due = valueAfter(rest, i, flag);
          if (!isCalendarDate(due)) throw new UsageError("--due は YYYY-MM-DD の実在日");
          command.due = due;
          i += 1;
          break;
        }
        case "--clear-due":
          if (command.due !== undefined) throw new UsageError("due の変更指定が重複している");
          command.due = null;
          break;
        case "--memo":
          if (command.memo !== undefined) throw new UsageError("memo の変更指定が重複している");
          command.memo = valueAfter(rest, i, flag);
          i += 1;
          break;
        case "--clear-memo":
          if (command.memo !== undefined) throw new UsageError("memo の変更指定が重複している");
          command.memo = null;
          break;
        default:
          throw new UsageError(`edit の知らない引数: ${JSON.stringify(flag)}`);
      }
    }
    const { kind: _kind, id: _id, ...changes } = command;
    if (Object.keys(changes).length === 0) throw new UsageError("edit には変更項目が要る");
    return command;
  }

  if (name === "delete") {
    if (rest.length !== 1) throw new UsageError("delete は todo delete <id> の形");
    return { kind: "delete", id: positiveId(rest[0]) };
  }

  throw new UsageError(`知らないサブコマンド: ${JSON.stringify(name)}`);
}
