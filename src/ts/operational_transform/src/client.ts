import { TextOperation } from "./text-operation.js";

/**
 * The client-side synchronization state machine (classic ot.js design; the
 * exact mirror of `ArchAstro.OperationalTransform.Client` in Elixir).
 *
 * States:
 *  - `synchronized`        — nothing in flight.
 *  - `awaitingConfirm`     — one operation sent, awaiting the server ack.
 *  - `awaitingWithBuffer`  — one in flight plus further local edits composed
 *                            into a buffer, sent right after the ack.
 *
 * Only one operation is ever in flight. All transforms are called as
 * `transform(own, serverOp)` — own operation on the left — matching the
 * server, so insert-position ties break identically everywhere.
 */

export type ClientStateName = "synchronized" | "awaitingConfirm" | "awaitingWithBuffer";

export interface SendInstruction {
  /** Revision the operation is based on. */
  revision: number;
  op: TextOperation;
}

type State =
  | { name: "synchronized" }
  | { name: "awaitingConfirm"; outstanding: TextOperation }
  | { name: "awaitingWithBuffer"; outstanding: TextOperation; buffer: TextOperation };

export class Client {
  revision: number;
  private state: State = { name: "synchronized" };

  constructor(revision = 0) {
    this.revision = revision;
  }

  get stateName(): ClientStateName {
    return this.state.name;
  }

  /** The in-flight operation, if any (already rebased over received ops). */
  get outstanding(): TextOperation | null {
    return this.state.name === "synchronized" ? null : this.state.outstanding;
  }

  /**
   * The local user produced `op` (already applied to their replica).
   * Returns a send instruction when the operation should go out now.
   */
  applyClient(op: TextOperation): SendInstruction | null {
    switch (this.state.name) {
      case "synchronized":
        this.state = { name: "awaitingConfirm", outstanding: op };
        return { revision: this.revision, op };
      case "awaitingConfirm":
        this.state = {
          name: "awaitingWithBuffer",
          outstanding: this.state.outstanding,
          buffer: op,
        };
        return null;
      case "awaitingWithBuffer":
        this.state = {
          name: "awaitingWithBuffer",
          outstanding: this.state.outstanding,
          buffer: this.state.buffer.compose(op),
        };
        return null;
    }
  }

  /**
   * A remote operation arrived (already transformed by the server to apply
   * at `this.revision`). Returns the operation to apply to the local
   * replica, transformed over any outstanding/buffered local edits.
   */
  applyServer(op: TextOperation): TextOperation {
    this.revision++;
    switch (this.state.name) {
      case "synchronized":
        return op;
      case "awaitingConfirm": {
        const [outstanding1, op1] = TextOperation.transform(this.state.outstanding, op);
        this.state = { name: "awaitingConfirm", outstanding: outstanding1 };
        return op1;
      }
      case "awaitingWithBuffer": {
        const [outstanding1, op1] = TextOperation.transform(this.state.outstanding, op);
        const [buffer1, op2] = TextOperation.transform(this.state.buffer, op1);
        this.state = { name: "awaitingWithBuffer", outstanding: outstanding1, buffer: buffer1 };
        return op2;
      }
    }
  }

  /**
   * The server acknowledged our outstanding operation. Returns the next send
   * instruction when a buffer was waiting.
   */
  serverAck(): SendInstruction | null {
    switch (this.state.name) {
      case "synchronized":
        throw new Error("serverAck received while synchronized");
      case "awaitingConfirm":
        this.revision++;
        this.state = { name: "synchronized" };
        return null;
      case "awaitingWithBuffer": {
        this.revision++;
        const buffer = this.state.buffer;
        this.state = { name: "awaitingConfirm", outstanding: buffer };
        return { revision: this.revision, op: buffer };
      }
    }
  }
}
