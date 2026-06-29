/**
 * Sample SDK runtime for the SSE contract tests.
 *
 * A minimal but real `HttpClient` providing the `streamSSE` primitive the
 * generated SSE methods target: it opens the request (any method + JSON body),
 * reads the `text/event-stream` response, and yields parsed `{ event, data }`
 * records. The shipped SDK runtimes (archastro-js / archastro-python) carry a
 * fuller implementation (auth, refresh, query strings); this is the reference
 * shape the harness contract tests exercise.
 *
 * `regenerate-sample-sdk.ts` copies this file into
 * `generated-sdk/src/runtime/http-client.ts`, where the generated resource
 * classes import it via `../runtime/http-client.js`.
 */

export interface HttpClientConfig {
  baseUrl: string;
}

export interface StreamOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface SseEvent {
  event: string;
  data: unknown;
}

export class HttpClient {
  constructor(private readonly config: HttpClientConfig) {}

  async *streamSSE(
    path: string,
    options: StreamOptions = {}
  ): AsyncIterable<SseEvent> {
    const { method = "GET", body, headers = {} } = options;
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        accept: "text/event-stream",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let detail = "";
      try {
        detail = JSON.stringify(await res.json());
      } catch {
        /* non-JSON error body */
      }
      throw new Error(`SSE request failed: ${res.status} ${detail}`);
    }
    if (!res.body) throw new Error("SSE response has no body");

    yield* parseEventStream(res.body);
  }
}

/** Parse a `text/event-stream` byte stream into `{ event, data }` records. */
async function* parseEventStream(
  body: ReadableStream<Uint8Array>
): AsyncIterable<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseBlock(block);
      if (ev) yield ev;
    }
    if (done) break;
  }
  const tail = parseBlock(buf);
  if (tail) yield tail;
}

function parseBlock(block: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (event === undefined && dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  let data: unknown = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    /* leave as the raw string */
  }
  return { event: event ?? "message", data };
}
