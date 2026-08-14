#!/usr/bin/env node
import { createTaskDb } from "@todo-mcp/core";

import { parseArgs, UsageError, USAGE } from "./args.ts";
import { executeCommand } from "./commands.ts";
import { ConfigError, resolveConfig } from "./config.ts";

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));
  if (command.kind === "help") {
    console.log(USAGE);
    return;
  }

  const config = resolveConfig(process.env);
  const db = createTaskDb(config);
  const lines = await executeCommand(command, { db, config });
  for (const line of lines) console.log(line);
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`引数エラー: ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (error instanceof ConfigError) {
    console.error(`設定エラー: ${error.message}`);
    console.error("README の CLI セットアップを確認してください");
    process.exitCode = 2;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
