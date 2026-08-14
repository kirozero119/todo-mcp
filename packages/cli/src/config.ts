import { workspaceSchema, type TursoConfig, type Workspace } from "@todo-mcp/core";

export interface CliConfig extends TursoConfig {
  userId: string;
  defaultWorkspace: Workspace;
}

export class ConfigError extends Error {}

const USER_ID_FORMAT = /^github:\d+$/;

/**
 * CLI の接続設定を環境変数から解決する。user_id をコマンド引数にしないのは、
 * 日常操作のたびに身元を選ばせると、タイプミスが「誰にも見えない別スコープ」への
 * 書き込みになるため。端末ごとに一度設定し、workspace だけを必要時に上書きする。
 */
export function resolveConfig(env: Record<string, string | undefined>): CliConfig {
  const url = env.TODO_DATABASE_URL?.trim();
  const authToken = env.TODO_AUTH_TOKEN?.trim();
  const userId = env.TODO_USER_ID?.trim();
  const workspace = env.TODO_WORKSPACE?.trim();

  const missing = [
    ["TODO_DATABASE_URL", url],
    ["TODO_AUTH_TOKEN", authToken],
    ["TODO_USER_ID", userId],
    ["TODO_WORKSPACE", workspace],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new ConfigError(`未設定の環境変数: ${missing.join(", ")}`);
  }

  if (!USER_ID_FORMAT.test(userId!)) {
    throw new ConfigError("TODO_USER_ID は github:<数値> の形で設定する");
  }
  const parsedWorkspace = workspaceSchema.safeParse(workspace);
  if (!parsedWorkspace.success) {
    throw new ConfigError("TODO_WORKSPACE は work か life を設定する");
  }
  try {
    new URL(url!.replace(/^libsql:/, "https:"));
  } catch {
    throw new ConfigError("TODO_DATABASE_URL が URL として読めない");
  }

  return {
    url: url!,
    authToken: authToken!,
    userId: userId!,
    defaultWorkspace: parsedWorkspace.data,
  };
}
