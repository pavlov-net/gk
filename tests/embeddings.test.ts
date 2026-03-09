import { describe, expect, mock, test } from "bun:test";
import { OllamaEmbedder } from "../src/embeddings";

describe("OllamaEmbedder", () => {
  test("embed returns float arrays from Ollama API", async () => {
    const mockResponse = {
      embeddings: [
        Array.from({ length: 768 }, (_, i) => i * 0.001),
        Array.from({ length: 768 }, (_, i) => i * 0.002),
      ],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(mockResponse), { status: 200 }),
    ) as typeof globalThis.fetch;

    try {
      const embedder = new OllamaEmbedder(
        "http://localhost:11434",
        "nomic-embed-text",
      );
      const results = await embedder.embed(["hello world", "test input"]);
      expect(results).toHaveLength(2);
      expect(results[0]).toHaveLength(768);
      expect(results[1]).toHaveLength(768);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("embed returns empty array for empty input", async () => {
    const embedder = new OllamaEmbedder(
      "http://localhost:11434",
      "nomic-embed-text",
    );
    const results = await embedder.embed([]);
    expect(results).toHaveLength(0);
  });

  test("isAvailable returns false when Ollama is not running", async () => {
    const embedder = new OllamaEmbedder(
      "http://localhost:99999",
      "nomic-embed-text",
    );
    const available = await embedder.isAvailable();
    expect(available).toBe(false);
  });
});
