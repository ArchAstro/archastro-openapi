import type { Frame } from "./frame.js";
import type { Transport } from "./contract-server.js";

/**
 * A paired in-process duplex transport. The server attaches one side,
 * the SDK (or test) drives the other.
 */
export interface InProcessPair {
  /** Hand to `ContractServer.attach()`. */
  serverSide: Transport;
  /** Use from your SDK / test code to send frames to the server. */
  clientSide: InProcessClient;
}

export interface InProcessClient {
  send(frame: Frame): void;
  close(): void;
  onFrame(listener: (frame: Frame) => void): () => void;
  onClose(listener: () => void): () => void;
  /** All frames sent from the server, captured in order. Useful for assertions. */
  readonly received: Frame[];
}

export function createInProcessPair(): InProcessPair {
  const serverFrameListeners = new Set<(frame: Frame) => void>();
  const clientFrameListeners = new Set<(frame: Frame) => void>();
  const serverCloseListeners = new Set<() => void>();
  const clientCloseListeners = new Set<() => void>();
  const received: Frame[] = [];
  let closed = false;

  const closeAll = () => {
    if (closed) return;
    closed = true;
    for (const l of serverCloseListeners) l();
    for (const l of clientCloseListeners) l();
  };

  // Deliver via queueMicrotask so that send() always returns before the
  // listeners fire. That matches real-network semantics and prevents races
  // where tests register a reply listener after calling send().
  const deliver = (listeners: Set<(f: Frame) => void>, frame: Frame): void => {
    queueMicrotask(() => {
      if (closed) return;
      for (const l of listeners) l(frame);
    });
  };

  const serverSide: Transport = {
    send(frame) {
      if (closed) return;
      received.push(frame);
      deliver(clientFrameListeners, frame);
    },
    close: closeAll,
    onFrame(listener) {
      serverFrameListeners.add(listener);
    },
    onClose(listener) {
      serverCloseListeners.add(listener);
    },
  };

  const clientSide: InProcessClient = {
    send(frame) {
      if (closed) return;
      deliver(serverFrameListeners, frame);
    },
    close: closeAll,
    onFrame(listener) {
      clientFrameListeners.add(listener);
      return () => clientFrameListeners.delete(listener);
    },
    onClose(listener) {
      clientCloseListeners.add(listener);
      return () => clientCloseListeners.delete(listener);
    },
    get received() {
      return received;
    },
  };

  return { serverSide, clientSide };
}
