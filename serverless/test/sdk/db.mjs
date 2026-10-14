// A test double of the platform's `sdk/db`: the parts this bot uses, backed
// by node:sqlite so raw SQL runs against a real SQLite.
import { DatabaseSync } from 'node:sqlite';

const SQL = Symbol('sql');
const COLUMN = Symbol('column');
export const TABLE = Symbol('table');

// ── sql tag ────────────────────────────────────────────────────────────────

export function sql(strings, ...values) {
  return { [SQL]: true, strings: [...strings], values };
}
sql.raw = (text) => ({ [SQL]: true, strings: [text], values: [] });

function bindable(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function compile(query, params) {
  if (typeof query === 'string') {
    const named = {};
    for (const [key, value] of Object.entries(params ?? {})) named[key.replace(/^[:$@]/, '')] = bindable(value);
    return { text: query, args: Object.keys(named).length ? [named] : [] };
  }
  const out = { text: '', args: [] };
  const walk = (q) => {
    q.strings.forEach((part, i) => {
      out.text += part;
      if (i >= q.values.length) return;
      const value = q.values[i];
      if (value?.[SQL]) walk(value);
      else if (value?.[COLUMN]) out.text += `"${value.name}"`;
      else {
        out.text += '?';
        out.args.push(bindable(value));
      }
    });
  };
  walk(query);
  return out;
}

// ── schema DSL (enough to build DDL from tgcloud/schema.js) ────────────────

class Column {
  constructor(type, name) {
    this[COLUMN] = true;
    this.type = type;
    this.name = name;
    this.mods = {};
  }
  primaryKey(opts = {}) { this.mods.pk = true; this.mods.autoIncrement = Boolean(opts.autoIncrement); return this; }
  notNull() { this.mods.notNull = true; return this; }
  unique() { this.mods.unique = true; return this; }
  default(value) { this.mods.default = value; return this; }
  deprecated() { this.mods.deprecated = true; return this; }
  references() { throw new Error('foreign keys are not supported'); }
}

const factory = (type) => (name, opts) => new Column(type, typeof name === 'string' ? name : undefined);
export const text = factory('TEXT');
export const integer = factory('INTEGER');
export const real = factory('REAL');
export const numeric = factory('NUMERIC');
export const blob = factory('BLOB');
export const boolean = factory('INTEGER');
export const json = factory('TEXT');

export function index(name) {
  return { on: (...cols) => ({ kind: 'index', name, cols, where: () => ({ kind: 'index', name, cols }) }) };
}
export function uniqueIndex(name) {
  return { on: (...cols) => ({ kind: 'unique', name, cols }) };
}

export function table(name, columns, extras) {
  for (const [key, col] of Object.entries(columns)) col.name ??= key;
  const indexes = extras ? Object.values(extras(columns)) : [];
  const t = { ...columns, [TABLE]: { name, columns: Object.values(columns), indexes } };
  return t;
}

function literal(value) {
  if (value?.[SQL]) return value.strings.join('');
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

export function ddl(t) {
  const { name, columns, indexes } = t[TABLE];
  const cols = columns
    .filter((c) => !c.mods.deprecated)
    .map((c) => {
      let def = `"${c.name}" ${c.type}`;
      if (c.mods.pk) def += ' PRIMARY KEY' + (c.mods.autoIncrement ? ' AUTOINCREMENT' : '');
      if (c.mods.notNull) def += ' NOT NULL';
      if (c.mods.unique) def += ' UNIQUE';
      if ('default' in c.mods) def += ` DEFAULT ${literal(c.mods.default)}`;
      return def;
    });
  const statements = [`CREATE TABLE "${name}" (${cols.join(', ')})`];
  for (const idx of indexes) {
    const kind = idx.kind === 'unique' ? 'UNIQUE INDEX' : 'INDEX';
    statements.push(`CREATE ${kind} "${idx.name}" ON "${name}" (${idx.cols.map((c) => `"${c.name}"`).join(', ')})`);
  }
  return statements;
}

// ── the database ───────────────────────────────────────────────────────────

let database = new DatabaseSync(':memory:');

export async function resetDb(schema) {
  database.close();
  database = new DatabaseSync(':memory:');
  for (const t of Object.values(schema)) {
    if (!t?.[TABLE]) continue;
    for (const statement of ddl(t)) database.exec(statement);
  }
}

export const db = {
  async run(query, params) {
    const { text: q, args } = compile(query, params);
    const stmt = database.prepare(q);
    if (/\breturning\b/i.test(q)) {
      const rows = stmt.all(...args);
      return { rowsAffected: rows.length, lastInsertRowid: 0, rows };
    }
    const r = stmt.run(...args);
    return { rowsAffected: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid), rows: [] };
  },
  async all(query, params) {
    const { text: q, args } = compile(query, params);
    return database.prepare(q).all(...args).map((row) => ({ ...row }));
  },
  async get(query, params) {
    const { text: q, args } = compile(query, params);
    const row = database.prepare(q).get(...args);
    return row ? { ...row } : null;
  },
  async values(query, params) {
    return (await db.all(query, params)).map((row) => Object.values(row));
  },
};

export default { ...db, sql, table, text, integer, real, numeric, blob, boolean, json, index, uniqueIndex };
