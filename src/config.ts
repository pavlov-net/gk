import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

export const Config = z.object({
  backend: z.enum(["sqlite", "dolt"]).default("sqlite"),
  db_path: z.string().default(".gk/knowledge.db"),

  // Dolt
  dolt_host: z.string().default("127.0.0.1"),
  dolt_port: z.number().int().default(3307),
  dolt_database: z.string().default("gk"),
  dolt_user: z.string().default("root"),
  dolt_password: z.string().default(""),

  // Temporal dynamics
  decay_base_days: z.number().positive().default(7),
  max_stability: z.number().positive().default(10.0),
  stability_growth: z.number().positive().default(1.2),
  tier_weights: z
    .object({
      overview: z.number().default(1.0),
      summary: z.number().default(0.7),
      detail: z.number().default(0.4),
    })
    .default({ overview: 1.0, summary: 0.7, detail: 0.4 }),

  // Embeddings
  embedding_model: z.string().default("nomic-embed-text"),
  embedding_dimensions: z.number().int().positive().default(768),
  ollama_url: z.string().default("http://localhost:11434"),
  keyword_weight: z.number().min(0).max(1).default(0.6),
  semantic_weight: z.number().min(0).max(1).default(0.4),

  // Server
  transport: z.enum(["stdio"]).default("stdio"),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(overrides?: Partial<Config>): Config {
  const fileConfig: Record<string, unknown> = {};

  for (const name of ["gk.yml", "gk.yaml"]) {
    if (existsSync(name)) {
      const text = readFileSync(name, "utf-8");
      for (const line of text.split("\n")) {
        const match = line.match(/^(\w+):\s*(.+)$/);
        if (match) {
          const [, key, val] = match;
          const trimmed = val!.trim().replace(/^["']|["']$/g, "");
          fileConfig[key!] = Number.isNaN(Number(trimmed))
            ? trimmed
            : Number(trimmed);
        }
      }
      break;
    }
  }

  const env: Record<string, unknown> = {};
  if (process.env.GK_BACKEND) env.backend = process.env.GK_BACKEND;
  if (process.env.GK_DB_PATH) env.db_path = process.env.GK_DB_PATH;
  if (process.env.GK_DOLT_HOST) env.dolt_host = process.env.GK_DOLT_HOST;
  if (process.env.GK_DOLT_PORT)
    env.dolt_port = Number(process.env.GK_DOLT_PORT);
  if (process.env.GK_DOLT_DATABASE)
    env.dolt_database = process.env.GK_DOLT_DATABASE;
  if (process.env.GK_DOLT_USER) env.dolt_user = process.env.GK_DOLT_USER;
  if (process.env.GK_DOLT_PASSWORD)
    env.dolt_password = process.env.GK_DOLT_PASSWORD;
  if (process.env.GK_DECAY_BASE_DAYS)
    env.decay_base_days = Number(process.env.GK_DECAY_BASE_DAYS);
  if (process.env.GK_EMBEDDING_MODEL)
    env.embedding_model = process.env.GK_EMBEDDING_MODEL;
  if (process.env.GK_EMBEDDING_DIMENSIONS)
    env.embedding_dimensions = Number(process.env.GK_EMBEDDING_DIMENSIONS);
  if (process.env.GK_OLLAMA_URL) env.ollama_url = process.env.GK_OLLAMA_URL;

  return Config.parse({ ...fileConfig, ...env, ...overrides });
}
