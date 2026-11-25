import Database from 'better-sqlite3';
import { loadTextFilter } from '../src/server/text-filter.js';

const filter = loadTextFilter();
if (!filter)
  throw new Error(
    '未找到词库，请配置 LOOP_SENSITIVE_WORDS_FILE 或创建 data/sensitive-words.txt',
  );

const db = new Database(process.env.DATABASE_PATH || 'data/loop.sqlite', {
  readonly: true,
  fileMustExist: true,
});
try {
  const rows = db
    .prepare<[], { field: string; id: string; value: string }>(
      `SELECT '昵称' AS field, id, nickname AS value FROM guests
       UNION ALL SELECT '房间名', id, name FROM rooms
       UNION ALL SELECT '房间简介', id, description FROM rooms`,
    )
    .iterate();
  let count = 0;
  for (const { field, id, value } of rows) {
    if (!filter(value)) continue;
    console.log(`${field}\t${id}`);
    count++;
  }
  console.log(`命中 ${count} 个字段`);
} finally {
  db.close();
}
