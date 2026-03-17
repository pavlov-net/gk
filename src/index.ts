import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type Backend, GraphDB } from "./backend";
import { type Config, loadConfig } from "./config";
import { OllamaEmbedder } from "./embeddings";
import { createServer } from "./server";

function createBackend(config: Config): Backend {
  if (config.backend === "dolt") {
    return GraphDB.forMysql({
      host: config.dolt_host,
      port: config.dolt_port,
      database: config.dolt_database,
      user: config.dolt_user,
      password: config.dolt_password,
    });
  }
  return GraphDB.forSqlite(config.db_path);
}

async function main() {
  const command = process.argv[2];
  const config = loadConfig();

  if (command === "init") {
    if (config.backend === "sqlite") {
      const dir = dirname(config.db_path);
      if (dir && dir !== "." && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    const backend = createBackend(config);
    await backend.initialize(config.embedding_dimensions);
    await backend.close();
    const location =
      config.backend === "dolt"
        ? `${config.dolt_host}:${config.dolt_port}/${config.dolt_database}`
        : config.db_path;
    console.log(`Initialized gk database at ${location}`);
    return;
  }

  // Default: serve
  const backend = createBackend(config);
  await backend.initialize(config.embedding_dimensions);
  const embedder = new OllamaEmbedder(
    config.ollama_url,
    config.embedding_model,
  );
  const mcpServer = createServer(backend, config, embedder);
  const transport = new StdioServerTransport();

  await mcpServer.connect(transport);

  const shutdown = async () => {
    try {
      await mcpServer.close();
      await backend.close();
    } catch (e) {
      console.error("Shutdown error:", e);
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
