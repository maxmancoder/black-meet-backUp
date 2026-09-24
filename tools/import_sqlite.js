'use strict';
// tools/import_sqlite.js - loads tools/mysql_dump/*.jsonl (from dump_mysql.php)
// into the SQLite DB. Boots the Node schema first, then INSERT OR REPLACE all
// rows, keeping original ids so relations stay valid.
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
process.env.BM_DB_PATH = process.env.BM_DB_PATH || path.join(ROOT, 'black_meet.db');

const dbm = require(path.join(ROOT, 'server', 'lib', 'db'));
if (!dbm.DB_PATH) throw new Error('no db path');
const dumpDir = path.join(__dirname, 'mysql_dump');
if (!fs.existsSync(dumpDir)) {
  console.error('no dump dir: run tools/dump_mysql.php first');
  process.exit(1);
}

const conn = dbm.db();
const sqliteCols = {};
for (const table of listTables()) {
  sqliteCols[table] = conn
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map(r => r.name);
}

function listTables() {
  return fs
    .readdirSync(dumpDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => f.replace(/\.jsonl$/, ''));
}

let total = 0;
for (const table of listTables()) {
  const lines = fs
    .readFileSync(path.join(dumpDir, table + '.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean);
  if (lines.length === 0) continue;
  const cols = sqliteCols[table];
  conn.exec('BEGIN');
  try {
    const stmt = conn.prepare(
      `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    );
    for (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch (e) {
        continue; // skip corrupt lines
      }
      stmt.run(...cols.map(c => (row[c] === undefined ? null : row[c])));
      total++;
    }
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    console.error('import failed for ' + table + ': ' + e.message);
    process.exit(1);
  }
  console.log('imported ' + table + ': ' + lines.length + ' rows');
}
console.log('TOTAL rows: ' + total + '  -> ' + dbm.DB_PATH);