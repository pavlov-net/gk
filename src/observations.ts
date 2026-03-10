import type { Backend } from "./backend";
import type { Config } from "./config";
import type { Embedder } from "./embeddings";
import { resolveEntityIds } from "./graph";
import { newId } from "./id";
import type { ObservationInput, ObservationRow } from "./types";

export interface ObservationResult {
  id: string;
  entity_names: string[];
}

export async function addObservations(
  backend: Backend,
  observations: ObservationInput[],
  embedder?: Embedder,
): Promise<ObservationResult[]> {
  if (observations.length === 0) return [];
  const results: ObservationResult[] = [];
  const ts = new Date().toISOString();

  // Batch-resolve all entity names upfront
  const allNames = observations.flatMap((o) => o.entity_names);
  const nameToId = await resolveEntityIds(backend, allNames);

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

      for (const entityName of input.entity_names) {
        await backend.run(
          "INSERT INTO observation_entities (observation_id, entity_id) VALUES (?, ?)",
          [id, nameToId.get(entityName)!],
        );
      }

      results.push({ id, entity_names: input.entity_names });
    }
  });

  // Sync FTS index for new observations
  if (results.length > 0) {
    await backend.syncObservationFts(results.map((r) => r.id));
  }

  // Embed after transaction succeeds (non-fatal on failure)
  if (embedder && results.length > 0) {
    try {
      const texts = observations.map((o) => o.content);
      const vectors = await embedder.embed(texts);
      await backend.storeEmbeddings(
        results.map((r, i) => ({ id: r.id, vector: vectors[i]! })),
      );
    } catch {
      // Graceful degradation: observation saved, embedding skipped
    }
  }

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
  embedder?: Embedder,
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

  return addObservations(backend, observations, embedder);
}

export async function backfillEmbeddings(
  backend: Backend,
  embedder: Embedder,
  options?: { batchSize?: number; force?: boolean },
): Promise<{
  embedded: number;
  skipped: number;
  errors: number;
  last_error?: string;
}> {
  const batchSize = options?.batchSize ?? 100;
  let embedded = 0;
  let errors = 0;
  let lastError: string | undefined;

  const baseQuery = options?.force
    ? "SELECT id, content FROM observations ORDER BY created_at"
    : `SELECT o.id, o.content FROM observations o
       LEFT JOIN observation_vectors v ON v.observation_id = o.id
       WHERE v.observation_id IS NULL
       ORDER BY o.created_at`;

  const coverage = await backend.getEmbeddingCoverage();
  let skipped = options?.force ? 0 : coverage.embedded;

  // Paginated fetch to avoid loading all observations into memory
  for (let offset = 0; ; offset += batchSize) {
    const batch = await backend.all<{ id: string; content: string }>(
      `${baseQuery} LIMIT ? OFFSET ?`,
      [batchSize, offset],
    );
    if (batch.length === 0) break;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const texts = batch.map((r) => r.content);
        const vectors = await embedder.embed(texts);
        await backend.storeEmbeddings(
          batch.map((r, j) => ({ id: r.id, vector: vectors[j]! })),
        );
        embedded += batch.length;
        break;
      } catch (e) {
        if (attempt === 1) {
          errors += batch.length;
          lastError = e instanceof Error ? e.message : String(e);
        }
      }
    }
  }

  // Recalculate skipped for force mode (total - what we processed)
  if (options?.force) {
    skipped = coverage.total - embedded - errors;
  }

  return {
    embedded,
    skipped,
    errors,
    ...(lastError && { last_error: lastError }),
  };
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
