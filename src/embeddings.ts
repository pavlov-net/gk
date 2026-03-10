export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
  isAvailable(): Promise<boolean>;
}

export class OllamaEmbedder implements Embedder {
  private url: string;
  private model: string;

  constructor(url: string, model: string) {
    this.url = url;
    this.model = model;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const response = await fetch(`${this.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama embed failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { embeddings: number[][] };
    return data.embeddings.map((e) => new Float32Array(e));
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.url}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
