import type { Backend } from "./backend";
import type { Config } from "./config";
import { newId } from "./id";
import type { ObservationInput, ObservationRow } from "./types";

export interface ObservationResult {
  id: string;
  entity_names: string[];
}

export async function addObservations(
  backend: Backend,
  observations: ObservationInput[],
): Promise<ObservationResult[]> {
  const results: ObservationResult[] = [];
  const ts = new Date().toISOString();

  await backend.transaction(async () => {
    for (const input of observations) {
      const id = newId();
      const metadata = input.metadata ? JSON.stringify(input.metadata) : "{}";
      const confidence = input.confidence ?? 0.8;

      await backend.run(
        `INSERT INTO observations (id, content, metadata, confidence, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, input.content, metadata, confidence, input.source ?? null, ts],
      );

      // Resolve entity names and create junction entries
      for (const entityName of input.entity_names) {
        const entity = await backend.get<{ id: string }>(
          "SELECT id FROM entities WHERE name = ?",
          [entityName],
        );
        if (!entity) {
          throw new Error(`Entity not found: ${entityName}`);
        }
        await backend.run(
          "INSERT INTO observation_entities (observation_id, entity_id) VALUES (?, ?)",
          [id, entity.id],
        );
      }

      results.push({ id, entity_names: input.entity_names });
    }
  });

  return results;
}

export async function readObservation(
  backend: Backend,
  id: string,
  config: Config,
): Promise<(ObservationRow & { entity_names: string[] }) | undefined> {
  const obs = await backend.get<ObservationRow>(
    "SELECT * FROM observations WHERE id = ?",
    [id],
  );
  if (!obs) return undefined;

  // Bump temporal fields
  const newStability = Math.min(
    obs.stability * config.stability_growth,
    config.max_stability,
  );
  await backend.run(
    `UPDATE observations SET
      access_count = access_count + 1,
      stability = ?,
      last_accessed = ?
    WHERE id = ?`,
    [newStability, new Date().toISOString(), id],
  );

  // Get linked entity names
  const entities = await backend.all<{ name: string }>(
    `SELECT e.name FROM entities e
     JOIN observation_entities oe ON oe.entity_id = e.id
     WHERE oe.observation_id = ?`,
    [id],
  );

  return {
    ...obs,
    stability: newStability,
    access_count: obs.access_count + 1,
    last_accessed: new Date().toISOString(),
    entity_names: entities.map((e) => e.name),
  };
}

export async function addChunkedObservation(
  backend: Backend,
  content: string,
  entityNames: string[],
  options?: {
    metadata?: Record<string, unknown>;
    confidence?: number;
    source?: string;
    maxChunkSize?: number;
  },
): Promise<ObservationResult[]> {
  const maxSize = options?.maxChunkSize ?? 2000;
  const chunks = splitIntoChunks(content, maxSize);
  const groupId = newId();

  const observations: ObservationInput[] = chunks.map((chunk, i) => ({
    content: chunk,
    entity_names: entityNames,
    metadata: {
      ...options?.metadata,
      chunk_index: i,
      chunk_total: chunks.length,
      chunk_group: groupId,
    },
    confidence: options?.confidence,
    source: options?.source,
  }));

  return addObservations(backend, observations);
}

function splitIntoChunks(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      chunks.push(remaining);
      break;
    }

    // Try to split at paragraph boundary
    let splitAt = remaining.lastIndexOf("\n\n", maxSize);
    if (splitAt <= 0) {
      // Try sentence boundary
      splitAt = remaining.lastIndexOf(". ", maxSize);
      if (splitAt > 0) splitAt += 2; // Include the ". "
    }
    if (splitAt <= 0) {
      // Force split at maxSize
      splitAt = maxSize;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks;
}
