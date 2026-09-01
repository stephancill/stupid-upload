// @ts-nocheck
// In-memory stand-ins for D1 and R2 that cover exactly the query shapes this
// codebase issues. Only supports the specific statements in src/db + src/quota.

export type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// D1 fake
// ---------------------------------------------------------------------------

export class FakeD1 {
  uploads: Row[] = [];
  daily: Row[] = [];
  feedback: Row[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(stmts: FakeStatement[]): Promise<{ results: Row[] }[]> {
    const out: { results: Row[] }[] = [];
    for (const s of stmts) out.push(await s.all());
    return out;
  }
}

export class FakeStatement {
  private args: unknown[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}
  bind(...v: unknown[]): this {
    this.args = v;
    return this;
  }

  private tableRows(): Row[] {
    if (
      /\bFROM uploads\b/i.test(this.sql) ||
      /\bINTO uploads\b/i.test(this.sql) ||
      /\bUPDATE uploads\b/i.test(this.sql)
    )
      return this.db.uploads;
    if (/\bdaily_usage\b/.test(this.sql)) return this.db.daily;
    if (/\bfeedback\b/.test(this.sql)) return this.db.feedback;
    throw new Error(`unmapped table for sql: ${this.sql}`);
  }

  async all(): Promise<{ results?: Row[]; meta: Record<string, unknown> }> {
    const { rows } = this.execute();
    return { results: rows, meta: {} };
  }

  async first<T = Row>(): Promise<T | null> {
    const { rows } = this.execute();
    return (rows[0] as T) ?? null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const { changes } = this.execute();
    return { meta: { changes } };
  }

  private execute(): { rows: Row[]; changes: number } {
    const sql = this.sql.trimStart();
    const a = this.args;
    const rows = this.tableRows();

    if (/^INSERT/i.test(sql)) {
      return this.doInsert(sql, a, rows);
    }
    if (/^SELECT/i.test(sql)) {
      return this.doSelect(sql, a, rows);
    }
    if (/^UPDATE/i.test(sql)) {
      return this.doUpdate(sql, a, rows);
    }
    throw new Error(`unsupported sql: ${sql}`);
  }

  private doInsert(sql: string, a: unknown[], rows: Row[]): { rows: Row[]; changes: number } {
    const colsM = /\(([^)]+)\)\s*VALUES\s*\(([\s\S]+?)\)\s*$/i.exec(sql);
    if (!colsM) throw new Error(`unsupported insert cols: ${sql}`);
    const cols = colsM[1].split(",").map((s) => s.trim());
    const tokens = colsM[2].split(",").map((s) => s.trim());
    const row: Row = {};
    let seq = 0;
    cols.forEach((col, i) => {
      const t = tokens[i] ?? "";
      const num = /^\?(\d+)$/.exec(t);
      if (num) row[col] = a[Number(num[1]) - 1];
      else if (t === "?") row[col] = a[seq++];
      else row[col] = unwrapLiteral(t);
    });
    const ignore = /INSERT\s+OR\s+IGNORE/i.test(sql);
    const key = cols.includes("id")
      ? "id"
      : cols.includes("scope")
        ? ["scope", "subject_hash", "utc_day"]
        : "id";
    const conflict = rows.some((r) => keyExists(r, row, key));
    if (!conflict) {
      rows.push(row);
      return { rows: [row], changes: 1 };
    }
    // On conflict, still record the row if id matches exactly (idempotent).
    return { rows: [], changes: ignore ? 0 : 1 };
  }

  private doSelect(sql: string, a: unknown[], rows: Row[]): { rows: Row[]; changes: number } {
    const where = /WHERE\s+([\s\S]+?)(?:\s+LIMIT\s+\d+)?$/i.exec(sql)?.[1];
    let out = rows;
    if (where) out = rows.filter((r) => whereMatch(where, r, a));
    const limit = /LIMIT\s+(\d+)/i.exec(sql);
    if (limit) out = out.slice(0, Number(limit[1]));
    return { rows: out, changes: 0 };
  }

  private doUpdate(sql: string, a: unknown[], rows: Row[]): { rows: Row[]; changes: number } {
    const whereM = /WHERE\s+([\s\S]+?)(?:\s+RETURNING\s+([\s\S]+))?$/i.exec(sql);
    if (!whereM) return { rows: [], changes: 0 };
    const where = whereM[1];
    const returning = whereM[2]?.trim();
    const setM = /SET\s+([\s\S]+?)\s*WHERE\s/i.exec(sql);
    const changed: Row[] = [];
    for (const r of rows) {
      if (!whereMatch(where, r, a)) continue;
      if (!guardOk(sql, r, a)) continue;
      if (setM) applySet(setM[1], r, a);
      changed.push(r);
    }
    if (returning) {
      const out = changed.map((r) => {
        const col = returning.replace(/\s+/g, "").trim();
        return { [col]: r[col] };
      });
      return { rows: out, changes: changed.length };
    }
    return { rows: changed, changes: changed.length };
  }
}

function unwrapLiteral(t: string): unknown {
  if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

function keyExists(r: Row, row: Row, key: string | string[]): boolean {
  const keys = Array.isArray(key) ? key : [key];
  return keys.every((k) => r[k] === row[k]);
}

function strVal(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

function whereMatch(where: string, row: Row, a: unknown[]): boolean {
  const ors = splitTop(where, "OR");
  if (ors.length > 1) return ors.some((p) => whereMatch(p.trim(), row, a));
  const ands = splitTop(where, "AND");
  return ands.every((p) => condMatch(p.trim(), row, a));
}

/** Split on a connective keyword at top paren depth, case-insensitively. */
function splitTop(s: string, word: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  const lower = s.toLowerCase();
  const kw = word.toLowerCase();
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (
      depth === 0 &&
      lower.startsWith(kw, i) &&
      isBoundary(s, i - 1) &&
      isBoundary(s, i + kw.length)
    ) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i += kw.length;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function isBoundary(s: string, i: number): boolean {
  const c = s[i] ?? "";
  return i < 0 || i >= s.length || !/[A-Za-z0-9_]/.test(c);
}

function condMatch(cond: string, row: Row, a: unknown[]): boolean {
  const c = cond.trim();
  const inM = /^(\w+)\s+(IN)\s*\(([^)]*)\)/.exec(c);
  if (inM) {
    const col = inM[1]!;
    const list = inM[3]!.split(",").map((t) => unwrapLiteral(t.trim()));
    return list.some((v) => strVal(row[col]) === strVal(v));
  }
  const notNull = /^(\w+)\s+IS\s+NOT\s+NULL/.exec(c);
  if (notNull) return row[notNull[1]!] !== null && row[notNull[1]!] !== undefined;

  // Guard expression like `reserved_bytes + ?1 <= ?5`
  const guard = /^(.*?)\s*(<=|>=|<|>|=|!=)\s*(.+)$/.exec(c);
  if (!guard) return false;
  const [, lhs, op, rhs] = guard;
  const l = exprValue(lhs!, row, a);
  const r = termVal(rhs!, a);
  if (typeof l === "number" && typeof r === "number") {
    switch (op!) {
      case "<=":
        return l <= r;
      case ">=":
        return l >= r;
      case "<":
        return l < r;
      case ">":
        return l > r;
      case "=":
        return l === r;
      default:
        return false;
    }
  }
  return cmpStr(strVal(l), op!, strVal(r));
}

function cmpStr(l: string, op: string, r: string): boolean {
  switch (op) {
    case "=":
      return l === r;
    case "!=":
      return l !== r;
    case "<":
      return l < r;
    case ">":
      return l > r;
    case "<=":
      return l <= r;
    case ">=":
      return l >= r;
    default:
      return false;
  }
}

function exprValue(expr: string, row: Row, a: unknown[]): unknown {
  const plus = /^(\w+)\s*\+\s*(.+)$/.exec(expr.trim());
  if (plus) {
    const left = Number(row[plus[1]!] ?? 0);
    const right = Number(termVal(plus[2]!, a) ?? 0);
    return left + right;
  }
  const num = /^\?(\d+)$/.exec(expr.trim());
  if (num) return a[Number(num[1]) - 1];
  if (row[expr.trim()] !== undefined) return row[expr.trim()];
  return expr.trim();
}

function termVal(tok: string, a: unknown[]): unknown {
  const t = tok.trim();
  const num = /^\?(\d+)$/.exec(t);
  if (num) return a[Number(num[1]!) - 1];
  if (t === "?") return a[0];
  return unwrapLiteral(t);
}

/** For quota guarded updates, the guard appears in the WHERE clause itself. */
function guardOk(_sql: string, _row: Row, _a: unknown[]): boolean {
  return true;
}

function applySet(setClause: string, row: Row, a: unknown[]): void {
  setClause.split(",").forEach((assign) => {
    const eq = assign.indexOf("=");
    if (eq < 0) return;
    const col = assign.slice(0, eq).trim();
    const expr = assign.slice(eq + 1).trim();
    // Self-referential increments: `reserved_bytes = reserved_bytes + ?N`
    const inc = /^\s*(\w+)\s*\+\s*(.+)$/.exec(expr);
    if (inc && inc[1] === col) {
      row[col] = ((row[col] as number) ?? 0) + (Number(termVal(inc[2]!, a)) || 0);
      return;
    }
    const num = /^\?(\d+)$/.exec(expr);
    if (num) row[col] = a[Number(num[1]!) - 1];
    else if (/^'.*'$/.test(expr)) row[col] = expr.slice(1, -1);
    else row[col] = Number(expr);
  });
}
// ---------------------------------------------------------------------------
// R2 fake
// ---------------------------------------------------------------------------
import { sha256 } from "../../src/crypto";

interface StoredObject {
  data: Uint8Array;
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
  etag: string;
  uploaded: Date;
  size: number;
}

export class FakeBucket {
  objects = new Map<string, StoredObject>();

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | string,
    options: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      sha256?: string;
    } = {},
  ): Promise<FakeObject> {
    const buf = await toBytes(value);
    const digest = await sha256(buf);
    if (options.sha256 && digest !== options.sha256) {
      throw new Error("checksum mismatch: sha256 does not match object data");
    }
    const obj: StoredObject = {
      data: buf,
      httpMetadata: {},
      customMetadata: options.customMetadata ?? {},
      etag: `"${digest.slice(0, 16)}"`,
      uploaded: new Date(),
      size: buf.length,
    };
    if (options.httpMetadata?.contentType) {
      obj.httpMetadata.contentType = options.httpMetadata.contentType;
    }
    this.objects.set(key, obj);
    return new FakeObject(obj);
  }

  async head(key: string): Promise<FakeObject | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return new FakeObject(o);
  }

  async get(
    key: string,
    opts?: { range?: { offset?: number; length?: number; suffix?: number } },
  ): Promise<FakeObject | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    let data = o.data;
    let range: { start: number; end: number; length?: number } | null = null;
    if (opts?.range) {
      let start = 0;
      let end = o.size - 1;
      if ("offset" in opts.range && opts.range.offset !== undefined) {
        start = opts.range.offset;
        end = (opts.range.length ?? o.size - start) + start - 1;
        end = Math.min(end, o.size - 1);
      } else if (opts.range.suffix !== undefined) {
        start = Math.max(0, o.size - opts.range.suffix);
      }
      range = { start, end, length: end - start + 1 };
      data = o.data.slice(start, end + 1);
    }
    return new FakeObject(o, {
      body: data,
      range: range ? { start: range.start, end: range.end } : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

interface GetCtx {
  body?: Uint8Array;
  range?: { start: number; end: number } | null;
}

export class FakeObject {
  readonly size: number;
  readonly httpEtag: string;
  readonly etag: string;
  readonly uploaded: Date;
  readonly key: string;
  readonly httpMetadata: { contentType?: string };
  readonly customMetadata: Record<string, string>;
  readonly body: ReadableStream | null;
  readonly range: { start: number; end: number } | null;

  constructor(o: StoredObject, ctx: GetCtx = {}) {
    this.size = o.size;
    this.httpEtag = o.etag;
    this.etag = o.etag;
    this.uploaded = o.uploaded;
    this.key = "";
    this.httpMetadata = o.httpMetadata;
    this.customMetadata = o.customMetadata;
    this.range = ctx.range ?? null;
    const data = ctx.body ?? new Uint8Array(0);
    this.body = new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
  }
  set() {}
  writeHttpMetadata(h: Headers): void {
    void h;
  }
}

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (value == null) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Request) return new Uint8Array(await value.arrayBuffer());
  // Assume it is a ReadableStream when given an object with getReader.
  if (value && typeof value === "object" && "getReader" in (value as object)) {
    return new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
  }
  throw new Error("unsupported body type");
}

// Convenience: a ready-to-use bindings object accepted by app.request().
export function makeTestEnv(vars: Record<string, unknown> = {}) {
  return {
    FILES: new FakeBucket(),
    DB: new FakeD1(),
    STUPID_UPLOAD_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    STUPID_UPLOAD_ADMIN_SECRET: "fedcba9876543210",
    STUPID_UPLOAD_BASE_URL: "https://upload.stupidtech.net",
    ...vars,
  } as unknown as Record<string, unknown> & { DB: FakeD1; FILES: FakeBucket };
}
