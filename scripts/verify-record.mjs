#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';

const [file, marker] = process.argv.slice(2);
if (!file || !marker) {
  console.error('usage: node verify-record.mjs <tasks.db> <literal marker>');
  process.exit(1);
}
const db = new DatabaseSync(file, { readOnly: true });
try {
  const columns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name));
  const fields = ['message_id', 'status', 'send_receipt', 'send_attempts',
    'text_send_results', 'file_send_results', 'created_at', 'updated_at']
    .filter(name => columns.has(name));
  const rows = db.prepare(`SELECT ${fields.join(', ')} FROM tasks
    WHERE instr(coalesce(text, ''), ?) > 0 ORDER BY created_at DESC LIMIT 3`).all(marker);
  console.log(JSON.stringify(rows, null, 2));
} finally {
  db.close();
}
