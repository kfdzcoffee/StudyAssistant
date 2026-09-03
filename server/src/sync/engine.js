// ===== 核心同步引擎 =====
// 按记录增量同步 + 冲突合并（last-write-wins）+ 软删除
// 每个数据集合（words/wenyan/todos/focus_records/errors/error_groups）
// 都遵循同一套协议：
//   客户端推送：{ collection, records: [{id, updatedAt, version, deleted, ...data}] }
//   服务端返回：{ pushed, conflicts, serverTime }
//   客户端拉取：GET /api/sync/:collection?since=<ISO时间>
//   服务端返回：{ records: [自 since 以来变更的记录], serverTime }

const pool = require('../db/pool');

// 各集合对应的数据库表
const TABLES = {
  words: 'words',
  wenyan: 'wenyan',
  todos: 'todos',
  focus_records: 'focus_records',
  errors: 'errors',
  error_groups: 'error_groups',
  notes: 'notes',
  settings: 'settings'
};

// 各集合的"业务主键"字段（用于 upsert 时定位记录）
// 大多数用 id；errors 用 number
const KEY_FIELDS = {
  words: 'id',
  wenyan: 'id',
  todos: 'id',
  focus_records: 'id',
  errors: 'number',
  error_groups: 'id',
  notes: 'path',
  settings: 'key'
};

// 各集合需要持久化的业务字段（除通用字段外）
// 这些字段会从客户端记录中提取并写入对应列
const DATA_COLUMNS = {
  words: ['word', 'type', 'linked', 'senses', 'review_stage', 'last_review', 'next_review', 'review_count', 'correct_count', 'wrong_count', 'created_at'],
  wenyan: ['char', 'type', 'senses', 'created_at'],
  todos: ['text', 'done', 'done_at', 'recurring', 'priority', 'due', 'created_at'],
  focus_records: ['data', 'created_at'],
  errors: ['number', 'data'],
  error_groups: ['name', 'data'],
  notes: ['path', 'content'],
  settings: ['key', 'value']
};

// 将客户端记录转换为数据库行
function toRow(collection, rec) {
  const row = { user_id: rec.userId };
  const keyField = KEY_FIELDS[collection];
  row[keyField] = rec[keyField] != null ? String(rec[keyField]) : rec.id;
  // errors 表有 NOT NULL 的 id 主键，但业务主键是 number。
  // 用 number 派生一个稳定的 id（err_<number>），保证插入不违反约束且幂等。
  if (collection === 'errors') {
    row.id = 'err_' + row.number;
  }
  // notes / settings 表同样有 NOT NULL 的 id 主键，但业务主键分别是 path / key。
  // 用业务主键派生稳定的 id，保证幂等。
  if (collection === 'notes') {
    row.id = 'note_' + row.path;
  }
  if (collection === 'settings') {
    row.id = 'set_' + row.key;
  }
  // 通用字段
  row.updated_at = rec.updatedAt || new Date().toISOString();
  row.version = Number(rec.version) || 1;
  row.deleted = !!rec.deleted;
  // 业务字段
  for (const col of DATA_COLUMNS[collection]) {
    if (rec[col] !== undefined) row[col] = rec[col];
  }
  return row;
}

// 将数据库行转换为客户端记录
function toClient(collection, row) {
  const keyField = KEY_FIELDS[collection];
  const rec = {
    id: row.id,
    updatedAt: row.updated_at,
    version: row.version,
    deleted: row.deleted
  };
  // 业务字段
  for (const col of DATA_COLUMNS[collection]) {
    if (row[col] !== undefined) rec[col] = row[col];
  }
  // errors 用 number 作为业务主键
  if (collection === 'errors') rec.number = row.number;
  return rec;
}

// 推送：客户端上传一批记录，服务端按 updatedAt 合并
// 主键为 (user_id, id)，因此不同用户可拥有相同 id 的记录而互不冲突。
// 用 ON CONFLICT (user_id, id) 做幂等 upsert，避免重复主键报错。
async function pushCollection(userId, collection, records) {
  const table = TABLES[collection];
  if (!table) return { ok: false, message: '未知集合: ' + collection };
  if (!Array.isArray(records)) return { ok: false, message: 'records 必须是数组' };

  const client = await pool.connect();
  const pushed = [];
  const conflicts = [];
  try {
    await client.query('BEGIN');
    for (const rec of records) {
      const keyField = KEY_FIELDS[collection];
      const keyVal = rec[keyField] != null ? String(rec[keyField]) : rec.id;
      if (!keyVal) continue;

      const row = toRow(collection, Object.assign({}, rec, { userId }));
      const cols = Object.keys(row);
      const vals = cols.map((c) => row[c]);
      const placeholders = cols.map((_, i) => '$' + (i + 1)).join(',');

      // 先尝试插入；若 (user_id, id) 已存在则跳过（不报错）
      const insRes = await client.query(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders}) ON CONFLICT (user_id, id) DO NOTHING`,
        vals
      );

      if (insRes.rowCount === 1) {
        // 新记录插入成功
        pushed.push(keyVal);
      } else {
        // (user_id, id) 已存在 → 按 updatedAt 做 last-write-wins
        const { rows } = await client.query(
          `SELECT * FROM ${table} WHERE user_id = $1 AND id = $2`,
          [userId, row.id]
        );
        const existing = rows[0];
        if (!existing) {
          // 理论上不会发生（id 已存在），防御性跳过
          continue;
        }
        const clientTime = new Date(rec.updatedAt || 0).getTime();
        const serverTime = new Date(existing.updated_at).getTime();
        if (clientTime >= serverTime) {
          // 客户端更新 → 覆盖云端
          const setCols = Object.keys(row).filter((c) => c !== 'id' && c !== 'user_id');
          const setSql = setCols.map((c, i) => `${c} = $${i + 1}`).join(',');
          const uvals = setCols.map((c) => row[c]);
          uvals.push(row.id, userId);
          await client.query(
            `UPDATE ${table} SET ${setSql} WHERE id = $${uvals.length - 1} AND user_id = $${uvals.length}`,
            uvals
          );
          pushed.push(keyVal);
        } else {
          // 云端更新 → 返回冲突，客户端需拉取云端版本
          conflicts.push(toClient(collection, existing));
        }
      }
    }
    await client.query('COMMIT');
    return { ok: true, pushed, conflicts, serverTime: new Date().toISOString() };
  } catch (e) {
    await client.query('ROLLBACK');
    return { ok: false, message: e.message };
  } finally {
    client.release();
  }
}

// 拉取：返回自 since 以来变更的记录
async function pullCollection(userId, collection, since) {
  const table = TABLES[collection];
  if (!table) return { ok: false, message: '未知集合: ' + collection };
  const sinceTime = since ? new Date(since).toISOString() : new Date(0).toISOString();
  const { rows } = await pool.query(
    `SELECT * FROM ${table} WHERE user_id = $1 AND updated_at > $2 ORDER BY updated_at ASC`,
    [userId, sinceTime]
  );
  return {
    ok: true,
    records: rows.map((r) => toClient(collection, r)),
    serverTime: new Date().toISOString()
  };
}

// 全量拉取（首次同步用）
async function pullAll(userId, collection) {
  const table = TABLES[collection];
  if (!table) return { ok: false, message: '未知集合: ' + collection };
  const { rows } = await pool.query(
    `SELECT * FROM ${table} WHERE user_id = $1 ORDER BY updated_at ASC`,
    [userId]
  );
  return {
    ok: true,
    records: rows.map((r) => toClient(collection, r)),
    serverTime: new Date().toISOString()
  };
}

module.exports = { pushCollection, pullCollection, pullAll, TABLES };
