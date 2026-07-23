/**
 * A text operation: an ordered list of retain / insert / delete components
 * that rewrites one document string into another.
 *
 * Wire format (identical to ot.js and to the Elixir
 * `ArchAstro.OperationalTransform.TextOperation`):
 *
 *   - positive integer `n`  — retain (skip) n characters
 *   - string `s`            — insert s at the current position
 *   - negative integer `-n` — delete n characters
 *
 * All lengths are measured in **Unicode code points** (never UTF-16 units),
 * matching the Elixir side so both languages agree on positions even for
 * emoji / astral-plane characters. Use the `cpLength` / `utf16OffsetToCp` /
 * `cpToUtf16Offset` helpers when talking to UTF-16-indexed APIs (DOM,
 * CodeMirror).
 */

export type OpComponent = number | string;

export function isRetain(c: OpComponent): c is number {
  return typeof c === "number" && c > 0;
}

export function isInsert(c: OpComponent): c is string {
  return typeof c === "string";
}

export function isDelete(c: OpComponent): c is number {
  return typeof c === "number" && c < 0;
}

/** Code-point length of a string — the unit all operations are measured in. */
export function cpLength(s: string): number {
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of s) n++;
  return n;
}

/** Slice by code-point indices (like String.slice but in code points). */
export function cpSlice(s: string, start: number, end?: number): string {
  return Array.from(s).slice(start, end).join("");
}

/** Convert a UTF-16 offset in `doc` to a code-point index. */
export function utf16OffsetToCp(doc: string, offset: number): number {
  let cp = 0;
  let u16 = 0;
  for (const ch of doc) {
    if (u16 >= offset) break;
    u16 += ch.length;
    cp++;
  }
  return cp;
}

/** Convert a code-point index in `doc` to a UTF-16 offset. */
export function cpToUtf16Offset(doc: string, cpIndex: number): number {
  let u16 = 0;
  let cp = 0;
  for (const ch of doc) {
    if (cp >= cpIndex) break;
    u16 += ch.length;
    cp++;
  }
  return u16;
}

export class TextOperation {
  /** Components in application order (canonical form). */
  ops: OpComponent[] = [];
  /** Code-point length of any document this operation applies to. */
  baseLength = 0;
  /** Code-point length of the result. */
  targetLength = 0;

  /** Skip over `n` characters. */
  retain(n: number): this {
    if (!Number.isInteger(n) || n < 0) throw new Error(`retain expects a non-negative integer`);
    if (n === 0) return this;
    this.baseLength += n;
    this.targetLength += n;
    const last = this.ops[this.ops.length - 1];
    if (typeof last === "number" && last > 0) {
      this.ops[this.ops.length - 1] = last + n;
    } else {
      this.ops.push(n);
    }
    return this;
  }

  /** Insert `text` at the current position. */
  insert(text: string): this {
    if (typeof text !== "string") throw new Error("insert expects a string");
    if (text === "") return this;
    this.targetLength += cpLength(text);
    const ops = this.ops;
    const last = ops[ops.length - 1];
    if (typeof last === "string") {
      ops[ops.length - 1] = last + text;
    } else if (typeof last === "number" && last < 0) {
      // Canonical form: an insert adjacent to a delete always goes first.
      const beforeDelete = ops[ops.length - 2];
      if (typeof beforeDelete === "string") {
        ops[ops.length - 2] = beforeDelete + text;
      } else {
        ops.splice(ops.length - 1, 0, text);
      }
    } else {
      ops.push(text);
    }
    return this;
  }

  /** Delete `n` characters (also accepts the string being deleted). */
  delete(n: number | string): this {
    if (typeof n === "string") n = cpLength(n);
    if (!Number.isInteger(n) || n < 0) throw new Error(`delete expects a non-negative integer`);
    if (n === 0) return this;
    this.baseLength += n;
    const last = this.ops[this.ops.length - 1];
    if (typeof last === "number" && last < 0) {
      this.ops[this.ops.length - 1] = last - n;
    } else {
      this.ops.push(-n);
    }
    return this;
  }

  /** True when the operation changes nothing (retains only). */
  isNoop(): boolean {
    return this.ops.length === 0 || (this.ops.length === 1 && isRetain(this.ops[0]!));
  }

  equals(other: TextOperation): boolean {
    return (
      this.baseLength === other.baseLength &&
      this.targetLength === other.targetLength &&
      this.ops.length === other.ops.length &&
      this.ops.every((op, i) => op === other.ops[i])
    );
  }

  /** ot.js-compatible wire format. */
  toJSON(): OpComponent[] {
    return this.ops.slice();
  }

  static fromJSON(ops: unknown): TextOperation {
    if (!Array.isArray(ops)) throw new Error("invalid operation: expected an array");
    const op = new TextOperation();
    for (const c of ops) {
      if (typeof c === "number" && Number.isInteger(c) && c > 0) op.retain(c);
      else if (typeof c === "number" && Number.isInteger(c) && c < 0) op.delete(-c);
      else if (typeof c === "string" && c !== "") op.insert(c);
      else throw new Error(`invalid operation component: ${JSON.stringify(c)}`);
    }
    return op;
  }

  /** Apply to a document string whose code-point length equals `baseLength`. */
  apply(doc: string): string {
    const chars = Array.from(doc);
    if (chars.length !== this.baseLength) {
      throw new Error(
        `cannot apply operation: expected doc length ${this.baseLength}, got ${chars.length}`,
      );
    }
    const parts: string[] = [];
    let index = 0;
    for (const c of this.ops) {
      if (isRetain(c)) {
        parts.push(chars.slice(index, index + c).join(""));
        index += c;
      } else if (isInsert(c)) {
        parts.push(c);
      } else {
        index -= c; // c is negative
      }
    }
    return parts.join("");
  }

  /** Inverse relative to the document the operation was applied to. */
  invert(doc: string): TextOperation {
    const chars = Array.from(doc);
    const inverse = new TextOperation();
    let index = 0;
    for (const c of this.ops) {
      if (isRetain(c)) {
        inverse.retain(c);
        index += c;
      } else if (isInsert(c)) {
        inverse.delete(cpLength(c));
      } else {
        inverse.insert(chars.slice(index, index - c).join(""));
        index -= c;
      }
    }
    return inverse;
  }

  /**
   * Compose with a consecutive operation:
   * `a.compose(b).apply(doc) === b.apply(a.apply(doc))`.
   */
  compose(b: TextOperation): TextOperation {
    const a = this;
    if (a.targetLength !== b.baseLength) {
      throw new Error(
        `cannot compose: first target length ${a.targetLength} != second base length ${b.baseLength}`,
      );
    }
    const result = new TextOperation();
    const as = a.ops.slice();
    const bs = b.ops.slice();
    let i = 0;
    let j = 0;
    let ca = as[i];
    let cb = bs[j];
    for (;;) {
      if (ca === undefined && cb === undefined) break;

      if (typeof ca === "number" && ca < 0) {
        result.delete(-ca);
        ca = as[++i];
        continue;
      }
      if (typeof cb === "string") {
        result.insert(cb);
        cb = bs[++j];
        continue;
      }
      if (ca === undefined || cb === undefined) {
        throw new Error("cannot compose: operations do not fit together");
      }

      if (typeof ca === "number" && typeof cb === "number" && ca > 0 && cb > 0) {
        if (ca > cb) {
          result.retain(cb);
          ca -= cb;
          cb = bs[++j];
        } else if (ca === cb) {
          result.retain(ca);
          ca = as[++i];
          cb = bs[++j];
        } else {
          result.retain(ca);
          cb -= ca;
          ca = as[++i];
        }
      } else if (typeof ca === "string" && typeof cb === "number" && cb < 0) {
        const alen = cpLength(ca);
        const dlen = -cb;
        if (alen > dlen) {
          ca = cpSlice(ca, dlen);
          cb = bs[++j];
        } else if (alen === dlen) {
          ca = as[++i];
          cb = bs[++j];
        } else {
          cb = -(dlen - alen);
          ca = as[++i];
        }
      } else if (typeof ca === "string" && typeof cb === "number" && cb > 0) {
        const alen = cpLength(ca);
        if (alen > cb) {
          result.insert(cpSlice(ca, 0, cb));
          ca = cpSlice(ca, cb);
          cb = bs[++j];
        } else if (alen === cb) {
          result.insert(ca);
          ca = as[++i];
          cb = bs[++j];
        } else {
          result.insert(ca);
          cb -= alen;
          ca = as[++i];
        }
      } else if (typeof ca === "number" && ca > 0 && typeof cb === "number" && cb < 0) {
        const dlen = -cb;
        if (ca > dlen) {
          result.delete(dlen);
          ca -= dlen;
          cb = bs[++j];
        } else if (ca === dlen) {
          result.delete(dlen);
          ca = as[++i];
          cb = bs[++j];
        } else {
          result.delete(ca);
          cb = -(dlen - ca);
          ca = as[++i];
        }
      } else {
        throw new Error("cannot compose: operations do not fit together");
      }
    }
    return result;
  }

  /**
   * The heart of OT (TP1). For concurrent `a` and `b` against the same
   * document, produces `[a', b']` with
   * `b'.apply(a.apply(doc)) === a'.apply(b.apply(doc))`.
   *
   * When both insert at the same position, `a`'s insert is ordered first —
   * same tie-break as the Elixir implementation (the server passes the
   * incoming operation as `a`; the client passes its own operation as `a`).
   */
  static transform(a: TextOperation, b: TextOperation): [TextOperation, TextOperation] {
    if (a.baseLength !== b.baseLength) {
      throw new Error(
        `cannot transform: base lengths differ (${a.baseLength} vs ${b.baseLength})`,
      );
    }
    const a1 = new TextOperation();
    const b1 = new TextOperation();
    const as = a.ops.slice();
    const bs = b.ops.slice();
    let i = 0;
    let j = 0;
    let ca = as[i];
    let cb = bs[j];
    for (;;) {
      if (ca === undefined && cb === undefined) break;

      // Inserts first; a wins ties.
      if (typeof ca === "string") {
        a1.insert(ca);
        b1.retain(cpLength(ca));
        ca = as[++i];
        continue;
      }
      if (typeof cb === "string") {
        a1.retain(cpLength(cb));
        b1.insert(cb);
        cb = bs[++j];
        continue;
      }
      if (ca === undefined || cb === undefined) {
        throw new Error("cannot transform: operations do not fit together");
      }

      let chunk: number;
      if (typeof ca === "number" && typeof cb === "number" && ca > 0 && cb > 0) {
        if (ca > cb) {
          chunk = cb;
          ca -= cb;
          cb = bs[++j];
        } else if (ca === cb) {
          chunk = ca;
          ca = as[++i];
          cb = bs[++j];
        } else {
          chunk = ca;
          cb -= ca;
          ca = as[++i];
        }
        a1.retain(chunk);
        b1.retain(chunk);
      } else if (typeof ca === "number" && ca < 0 && typeof cb === "number" && cb < 0) {
        // Both deleted the same span: no one needs to do anything.
        const da = -ca;
        const db = -cb;
        if (da > db) {
          ca = -(da - db);
          cb = bs[++j];
        } else if (da === db) {
          ca = as[++i];
          cb = bs[++j];
        } else {
          cb = -(db - da);
          ca = as[++i];
        }
      } else if (typeof ca === "number" && ca < 0 && typeof cb === "number" && cb > 0) {
        const da = -ca;
        if (da > cb) {
          chunk = cb;
          ca = -(da - cb);
          cb = bs[++j];
        } else if (da === cb) {
          chunk = da;
          ca = as[++i];
          cb = bs[++j];
        } else {
          chunk = da;
          cb -= da;
          ca = as[++i];
        }
        a1.delete(chunk);
      } else if (typeof ca === "number" && ca > 0 && typeof cb === "number" && cb < 0) {
        const db = -cb;
        if (ca > db) {
          chunk = db;
          ca -= db;
          cb = bs[++j];
        } else if (ca === db) {
          chunk = ca;
          ca = as[++i];
          cb = bs[++j];
        } else {
          chunk = ca;
          cb = -(db - ca);
          ca = as[++i];
        }
        b1.delete(chunk);
      } else {
        throw new Error("cannot transform: operations do not fit together");
      }
    }
    return [a1, b1];
  }

  /**
   * Transform a cursor position (code-point index) against an operation.
   * Inserts at or before the cursor push it right; deletes spanning it clamp
   * it. Mirrors ot.js `Cursor.transform` and the Elixir `transform_index/2`.
   */
  static transformIndex(index: number, op: TextOperation): number {
    let countdown = index;
    let result = index;
    for (const c of op.ops) {
      if (isRetain(c)) {
        countdown -= c;
        if (countdown < 0) break;
      } else if (isInsert(c)) {
        result += cpLength(c);
      } else {
        const d = -c;
        result -= Math.min(countdown, d);
        countdown -= d;
        if (countdown < 0) break;
      }
    }
    return Math.max(result, 0);
  }
}
