import { describe, expect, test } from "vitest";
import { Client } from "../src/client.js";
import { TextOperation, cpLength } from "../src/text-operation.js";

/**
 * Randomized convergence simulation: an in-memory authoritative server (the
 * same algorithm as `ArchAstro.OperationalTransform.Document`) plus N
 * simulated editors, with submissions, broadcasts and acks delivered in
 * random interleavings. After the network drains, every replica must equal
 * the server content. This is the TypeScript twin of the Elixir
 * ActorConvergenceTest.
 */

// Deterministic PRNG (mulberry32) so failures are reproducible by seed.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [..."abcdefgh \nö💡é*#"];

class SimServer {
  content: string;
  revision = 0;
  history: TextOperation[] = [];

  constructor(content: string) {
    this.content = content;
  }

  receive(revision: number, op: TextOperation): TextOperation {
    if (revision < 0 || revision > this.revision) throw new Error("unknown revision");
    let transformed = op;
    for (const applied of this.history.slice(revision)) {
      [transformed] = TextOperation.transform(transformed, applied);
    }
    this.content = transformed.apply(this.content);
    this.revision++;
    this.history.push(transformed);
    return transformed;
  }
}

type InboxMessage = { type: "ack" } | { type: "op"; op: TextOperation };

class SimEditor {
  client: Client;
  replica: string;
  inbox: InboxMessage[] = [];

  constructor(revision: number, content: string) {
    this.client = new Client(revision);
    this.replica = content;
  }
}

interface Submission {
  editorIndex: number;
  revision: number;
  op: TextOperation;
}

function randomString(rand: () => number, maxLen: number): string {
  const len = Math.floor(rand() * maxLen) + 1;
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

function randomOperation(rand: () => number, doc: string): TextOperation {
  const len = cpLength(doc);
  const op = new TextOperation();
  if (len === 0 || rand() < 0.6) {
    const pos = Math.floor(rand() * (len + 1));
    return op.retain(pos).insert(randomString(rand, 6)).retain(len - pos);
  }
  const pos = Math.floor(rand() * len);
  const count = Math.min(1 + Math.floor(rand() * 4), len - pos);
  return op.retain(pos).delete(count).retain(len - pos - count);
}

function runSimulation(seed: number, editorCount: number, editCount: number): void {
  const rand = prng(seed);
  const server = new SimServer("# Fuzz doc\n\nhello world\n");
  const editors = Array.from(
    { length: editorCount },
    () => new SimEditor(server.revision, server.content),
  );
  const serverQueue: Submission[] = [];
  let editsRemaining = editCount;

  const submit = (editorIndex: number, send: { revision: number; op: TextOperation } | null) => {
    if (send) serverQueue.push({ editorIndex, revision: send.revision, op: send.op });
  };

  const stepEdit = () => {
    const idx = Math.floor(rand() * editors.length);
    const editor = editors[idx]!;
    const op = randomOperation(rand, editor.replica);
    editor.replica = op.apply(editor.replica);
    submit(idx, editor.client.applyClient(op));
    editsRemaining--;
  };

  const stepServer = () => {
    const submission = serverQueue.shift();
    if (!submission) return;
    const transformed = server.receive(submission.revision, submission.op);
    editors.forEach((editor, i) => {
      // FIFO per editor, like one websocket: ack and broadcasts stay ordered.
      editor.inbox.push(
        i === submission.editorIndex ? { type: "ack" } : { type: "op", op: transformed },
      );
    });
  };

  const stepDeliver = () => {
    const candidates = editors.filter((e) => e.inbox.length > 0);
    if (candidates.length === 0) return;
    const editor = candidates[Math.floor(rand() * candidates.length)]!;
    const msg = editor.inbox.shift()!;
    if (msg.type === "ack") {
      submit(editors.indexOf(editor), editor.client.serverAck());
    } else {
      const toApply = editor.client.applyServer(msg.op);
      editor.replica = toApply.apply(editor.replica);
    }
  };

  // Random interleaving while edits remain…
  while (editsRemaining > 0) {
    const dice = rand();
    if (dice < 0.4) stepEdit();
    else if (dice < 0.7) stepServer();
    else stepDeliver();
  }
  // …then drain the network completely.
  for (let guard = 0; guard < 100_000; guard++) {
    if (serverQueue.length === 0 && editors.every((e) => e.inbox.length === 0)) break;
    if (serverQueue.length > 0 && rand() < 0.5) stepServer();
    else if (editors.some((e) => e.inbox.length > 0)) stepDeliver();
    else stepServer();
  }

  expect(serverQueue.length, `seed ${seed}: server queue drained`).toBe(0);
  editors.forEach((editor, i) => {
    expect(editor.inbox.length, `seed ${seed}: editor ${i} inbox drained`).toBe(0);
    expect(editor.client.stateName, `seed ${seed}: editor ${i} synchronized`).toBe("synchronized");
    expect(editor.replica, `seed ${seed}: editor ${i} converged`).toBe(server.content);
  });
}

describe("randomized multi-editor convergence", () => {
  test("2 editors, 100 runs", () => {
    for (let seed = 1; seed <= 100; seed++) runSimulation(seed, 2, 30);
  });

  test("5 editors, 50 runs", () => {
    for (let seed = 500; seed < 550; seed++) runSimulation(seed, 5, 60);
  });

  test("8 editors heavy contention, 20 runs", () => {
    for (let seed = 900; seed < 920; seed++) runSimulation(seed, 8, 120);
  });
});
