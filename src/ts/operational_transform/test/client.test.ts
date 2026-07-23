import { describe, expect, test } from "vitest";
import { Client } from "../src/client.js";
import { TextOperation, cpLength } from "../src/text-operation.js";

function insertAt(pos: number, text: string, len: number): TextOperation {
  return new TextOperation().retain(pos).insert(text).retain(len - pos);
}

describe("Client state machine", () => {
  test("synchronized: local edit is sent immediately", () => {
    const client = new Client(3);
    const op = insertAt(0, "x", 0);

    const send = client.applyClient(op);
    expect(send).toEqual({ revision: 3, op });
    expect(client.stateName).toBe("awaitingConfirm");
  });

  test("awaitingConfirm: further edits buffer; ack flushes the buffer", () => {
    const client = new Client(0);

    expect(client.applyClient(insertAt(0, "a", 0))).not.toBeNull();
    expect(client.applyClient(insertAt(1, "b", 1))).toBeNull();
    expect(client.applyClient(insertAt(2, "c", 2))).toBeNull();
    expect(client.stateName).toBe("awaitingWithBuffer");

    const send = client.serverAck();
    expect(send?.revision).toBe(1);
    expect(send?.op.toJSON()).toEqual([1, "bc"]);
    expect(client.stateName).toBe("awaitingConfirm");

    expect(client.serverAck()).toBeNull();
    expect(client.stateName).toBe("synchronized");
    expect(client.revision).toBe(2);
  });

  test("serverAck while synchronized throws", () => {
    expect(() => new Client(0).serverAck()).toThrow();
  });

  test("remote ops are transformed over outstanding and buffered edits", () => {
    // Mirror of the Elixir ClientTest scenario.
    const client = new Client(0);
    let local = "ab";

    const opX = insertAt(0, "X", 2);
    local = opX.apply(local);
    expect(client.applyClient(opX)).not.toBeNull();

    const opY = insertAt(1, "Y", 3);
    local = opY.apply(local);
    expect(client.applyClient(opY)).toBeNull();
    expect(local).toBe("XYab");

    const remote = new TextOperation().retain(2).insert("R");
    const toApply = client.applyServer(remote);
    local = toApply.apply(local);

    expect(local).toBe("XYabR");
    expect(client.revision).toBe(1);

    // Simulate the server: remote landed first, then our two ops.
    let server = "abR";
    const [xPrime] = TextOperation.transform(opX, remote);
    server = xPrime.apply(server);

    const send = client.serverAck();
    expect(send).not.toBeNull();
    server = send!.op.apply(server);
    expect(client.serverAck()).toBeNull();

    expect(server).toBe(local);
    expect(cpLength(server)).toBe(cpLength(local));
  });
});
