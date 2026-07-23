import { Channel, Socket } from "phoenix";
import { Client } from "./client.js";
import { TextOperation } from "./text-operation.js";

/**
 * A live connection to one collaboratively edited document, over the wire
 * protocol served by the example Phoenix server
 * (`ArchAstro.OtExampleWeb.DocChannel`).
 *
 * The session owns the `Client` state machine and a shadow copy of the
 * document; the editor binds to it with four calls:
 *
 *   session.on("ready", ({ content }) => showDocument(content));
 *   session.on("operation", ({ op }) => applyToEditor(op));
 *   editorChanged(op)  ->  session.applyLocal(op);
 *   selectionChanged() ->  session.sendCursor(cursor);
 */

export interface ActorMeta {
  name: string;
  color: string;
}

export interface CursorPosition {
  /** Code-point index of the selection anchor. */
  position: number;
  /** Code-point index of the selection head (== position when collapsed). */
  selection_end: number;
}

export interface ActorState {
  actorId: string;
  meta: ActorMeta;
  cursor: CursorPosition | null;
}

export interface DocSnapshot {
  actorId: string;
  content: string;
  revision: number;
  actors: ActorState[];
}

export type SyncStatus = "connecting" | "synchronized" | "pending" | "offline" | "error";

export interface DocSessionEvents {
  /** Join succeeded; carries the initial snapshot. Fires again on rejoin. */
  ready: (snapshot: DocSnapshot) => void;
  /** A remote operation, already transformed to fit the local replica. */
  operation: (event: { actorId: string; op: TextOperation; cursor: CursorPosition | null }) => void;
  cursor: (event: { actorId: string; cursor: CursorPosition | null }) => void;
  actorJoined: (actor: ActorState) => void;
  actorLeft: (event: { actorId: string }) => void;
  statusChange: (status: SyncStatus) => void;
  error: (message: string) => void;
}

export interface DocSessionOptions {
  /** Websocket endpoint, e.g. `ws://localhost:4000/socket`. */
  url: string;
  docId: string;
  name?: string;
  color?: string;
  /** Stable id for this actor; generated when omitted. */
  actorId?: string;
  /** Injectable for tests. */
  socket?: Socket;
}

export class DocSession {
  readonly docId: string;
  readonly actorId: string;

  /** Shadow replica (always equals editor content when used correctly). */
  content = "";
  client: Client = new Client(0);
  actors = new Map<string, ActorState>();
  status: SyncStatus = "connecting";

  private socket: Socket;
  private channel: Channel | null = null;
  private handlers: { [K in keyof DocSessionEvents]: Set<DocSessionEvents[K]> } = {
    ready: new Set(),
    operation: new Set(),
    cursor: new Set(),
    actorJoined: new Set(),
    actorLeft: new Set(),
    statusChange: new Set(),
    error: new Set(),
  };
  private options: DocSessionOptions;
  private joinedOnce = false;

  constructor(options: DocSessionOptions) {
    this.options = options;
    this.docId = options.docId;
    this.actorId = options.actorId ?? `actor-${Math.random().toString(36).slice(2, 12)}`;
    this.socket =
      options.socket ??
      new Socket(options.url, { params: { actor_id: this.actorId } });
  }

  on<K extends keyof DocSessionEvents>(event: K, handler: DocSessionEvents[K]): () => void {
    this.handlers[event].add(handler);
    return () => this.handlers[event].delete(handler);
  }

  private emit<K extends keyof DocSessionEvents>(
    event: K,
    ...args: Parameters<DocSessionEvents[K]>
  ): void {
    for (const handler of this.handlers[event]) {
      (handler as (...a: Parameters<DocSessionEvents[K]>) => void)(...args);
    }
  }

  private setStatus(status: SyncStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.emit("statusChange", status);
    }
  }

  connect(): void {
    this.socket.onError(() => this.setStatus("offline"));
    this.socket.connect();

    const channel = this.socket.channel(`doc:${this.docId}`, {
      name: this.options.name ?? "Anonymous",
      color: this.options.color ?? "#4f6df5",
    });
    this.channel = channel;

    channel.on("operation", (payload: { actor_id: string; op: unknown; cursor: CursorPosition | null }) => {
      const op = this.client.applyServer(TextOperation.fromJSON(payload.op));
      this.content = op.apply(this.content);
      this.trackRemoteCursor(payload.actor_id, payload.cursor ?? null);
      this.emit("operation", { actorId: payload.actor_id, op, cursor: payload.cursor ?? null });
    });

    channel.on("cursor", (payload: { actor_id: string; cursor: CursorPosition | null }) => {
      this.trackRemoteCursor(payload.actor_id, payload.cursor);
      this.emit("cursor", { actorId: payload.actor_id, cursor: payload.cursor });
    });

    channel.on("actor_joined", (payload: { actor_id: string; meta: ActorMeta }) => {
      const actor: ActorState = { actorId: payload.actor_id, meta: payload.meta, cursor: null };
      this.actors.set(actor.actorId, actor);
      this.emit("actorJoined", actor);
    });

    channel.on("actor_left", (payload: { actor_id: string }) => {
      this.actors.delete(payload.actor_id);
      this.emit("actorLeft", { actorId: payload.actor_id });
    });

    channel
      .join()
      .receive("ok", (reply: {
        actor_id: string;
        content: string;
        revision: number;
        actors: { actor_id: string; meta: ActorMeta; cursor: CursorPosition | null }[];
      }) => {
        // A rejoin after reconnect gets a fresh snapshot; any unacknowledged
        // local edits are abandoned (documented prototype limitation).
        this.content = reply.content;
        this.client = new Client(reply.revision);
        this.actors = new Map(
          reply.actors.map((a) => [
            a.actor_id,
            { actorId: a.actor_id, meta: a.meta, cursor: a.cursor },
          ]),
        );
        this.joinedOnce = true;
        this.setStatus("synchronized");
        this.emit("ready", {
          actorId: this.actorId,
          content: reply.content,
          revision: reply.revision,
          actors: [...this.actors.values()],
        });
      })
      .receive("error", (reason: unknown) => {
        this.setStatus("error");
        this.emit("error", `join failed: ${JSON.stringify(reason)}`);
      });
  }

  disconnect(): void {
    this.channel?.leave();
    this.socket.disconnect();
    this.setStatus("offline");
  }

  /**
   * The local editor applied `op` to its document. The session updates its
   * shadow copy, runs the state machine and sends when instructed.
   */
  applyLocal(op: TextOperation, cursor?: CursorPosition): void {
    this.content = op.apply(this.content);
    const send = this.client.applyClient(op);
    this.setStatus("pending");
    if (send) this.sendOperation(send.revision, send.op, cursor ?? null);
  }

  /** Fire-and-forget selection broadcast. */
  sendCursor(cursor: CursorPosition | null): void {
    if (this.joinedOnce) this.channel?.push("cursor", { cursor });
  }

  private sendOperation(revision: number, op: TextOperation, cursor: CursorPosition | null): void {
    if (!this.channel) throw new Error("not connected");
    this.channel
      .push("operation", { revision, op: op.toJSON(), cursor })
      .receive("ok", () => {
        const next = this.client.serverAck();
        if (next) {
          this.sendOperation(next.revision, next.op, null);
        } else {
          this.setStatus("synchronized");
        }
      })
      .receive("error", (reason: unknown) => {
        this.setStatus("error");
        this.emit("error", `operation rejected: ${JSON.stringify(reason)}`);
      })
      .receive("timeout", () => {
        this.setStatus("offline");
        this.emit("error", "operation timed out");
      });
  }

  private trackRemoteCursor(actorId: string, cursor: CursorPosition | null): void {
    const actor = this.actors.get(actorId);
    if (actor) actor.cursor = cursor;
  }
}
