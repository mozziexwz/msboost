import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys=ON');
const folder = fileURLToPath(new URL('../drizzle/', import.meta.url));
for (const f of fs
  .readdirSync(folder)
  .filter((f) => f.endsWith('.sql'))
  .sort())
  sqlite.exec(fs.readFileSync(path.join(folder, f), 'utf8'));
class Prepared {
  sql: string;
  args: any[] = [];
  constructor(sql: string) {
    this.sql = sql;
  }
  bind(...args: any[]) {
    this.args = args;
    return this;
  }
  async first() {
    return sqlite.prepare(this.sql).get(...this.args) || null;
  }
  async all() {
    return { results: sqlite.prepare(this.sql).all(...this.args) };
  }
  async run() {
    const r = sqlite.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}
export const objects = new Map<string, string>();
export const env: any = {
  APP_ENCRYPTION_KEY: 'a'.repeat(64),
  PUBLIC_ORIGIN: 'https://msboost.de',
  OWNER_EMAIL: 'admin@qq.com',
  DB: {
    prepare: (sql: string) => new Prepared(sql),
    batch: async (statements: Prepared[]) => {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) {
          const r = sqlite.prepare(s.sql).run(...s.args);
          results.push({ success: true, meta: { changes: Number(r.changes) } });
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  },
  CONFIGS: {
    put: async (k: string, v: string) => {
      objects.set(k, v);
    },
    get: async (k: string) =>
      objects.has(k) ? { text: async () => objects.get(k)! } : null,
    delete: async (k: string) => {
      objects.delete(k);
    },
  },
};
