import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Backend } from "./backend";
import { type Config, loadConfig } from "./config";
import { DoltBackend } from "./dolt";
import { createServer } from "./server";
import { SqliteBackend } from "./sqlite";

function createBackend(config: Config): Backend {
  if (config.backend === "dolt") {
    return new DoltBackend({
      host: config.dolt_host,
      port: config.dolt_port,
      database: config.dolt_database,
      user: config.dolt_user,
      password: config.dolt_password,
    });
  }
  return new SqliteBackend(config.db_path);
}

async function main() {
  const command = process.argv[2];
  const config = loadConfig();

  if (command === "init") {
    const dir = dirname(config.db_path);
    if (dir && dir !== "." && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const backend = createBackend(config);
    await backend.initialize();
    await backend.close();
    console.log(`Initialized gk database at ${config.db_path}`);
    return;
  }

  // Default: serve
  const backend = createBackend(config);
  await backend.initialize();
  const mcpServer = createServer(backend, config);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
