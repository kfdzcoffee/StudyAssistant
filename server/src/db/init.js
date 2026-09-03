// ===== 数据库初始化脚本 =====
// 创建所有数据表。运行：npm run init-db
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SCHEMA = `
-- 服务器配置表（端口、JWT密钥、CORS等，可在管理面板中可视化修改）
CREATE TABLE IF NOT EXISTS server_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 管理员表（管理面板账号，可在面板中修改）
CREATE TABLE IF NOT EXISTS admin_users (
  id          TEXT PRIMARY KEY,
  username    TEXT UNIQUE NOT NULL,
  password    TEXT NOT NULL,          -- bcrypt 哈希
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  username    TEXT UNIQUE NOT NULL,
  password    TEXT NOT NULL,          -- bcrypt 哈希
  nickname    TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- 设备表（记录已注册的电脑/手机，用于实时推送）
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT DEFAULT '',
  platform    TEXT DEFAULT '',        -- 'desktop' | 'mobile'
  token       TEXT DEFAULT '',        -- 推送令牌（预留）
  last_seen   TIMESTAMPTZ DEFAULT now(),
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- 同步游标表（记录每个设备/用户上次同步到哪）
CREATE TABLE IF NOT EXISTS sync_cursors (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, device_id)
);

-- ===== 通用记录表（按记录增量同步） =====
-- 每条记录带 updated_at（最后修改时间）与 version（修改次数）
-- deleted 为软删除标记，用于传播删除操作

-- 生词本（英语单词）
CREATE TABLE IF NOT EXISTS words (
  id          TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  word        TEXT NOT NULL,
  type        TEXT DEFAULT 'word',
  linked      TEXT DEFAULT '',
  senses      JSONB DEFAULT '[]',
  review_stage INT DEFAULT 0,
  last_review TEXT DEFAULT '',
  next_review TEXT DEFAULT '',
  review_count INT DEFAULT 0,
  correct_count INT DEFAULT 0,
  wrong_count INT DEFAULT 0,
  created_at  TEXT DEFAULT '',
  updated_at  TIMESTAMPTZ DEFAULT now(),
  version     INT DEFAULT 1,
  deleted     BOOLEAN DEFAULT false,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_words_user ON words(user_id, updated_at);

-- 文言文生义
CREATE TABLE IF NOT EXISTS wenyan (
  id          TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  char        TEXT NOT NULL,
  type        TEXT DEFAULT '字',
  senses      JSONB DEFAULT '[]',
  created_at  TEXT DEFAULT '',
  updated_at  TIMESTAMPTZ DEFAULT now(),
  version     INT DEFAULT 1,
  deleted     BOOLEAN DEFAULT false,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_wenyan_user ON wenyan(user_id, updated_at);

-- 任务待办
CREATE TABLE IF NOT EXISTS todos (
  id          TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  done        BOOLEAN DEFAULT false,
  done_at     TEXT DEFAULT '',
  recurring   TEXT DEFAULT '',
  priority    TEXT DEFAULT 'normal',
  due         TEXT DEFAULT '',
  created_at  TEXT DEFAULT '',
  updated_at  TIMESTAMPTZ DEFAULT now(),
  version     INT DEFAULT 1,
  deleted     BOOLEAN DEFAULT false,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id, updated_at);

-- 专注记录
CREATE TABLE IF NOT EXISTS focus_records (
  id          TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data        JSONB DEFAULT '{}',
  created_at  TEXT DEFAULT '',
  updated_at  TIMESTAMPTZ DEFAULT now(),
  version     INT DEFAULT 1,
  deleted     BOOLEAN DEFAULT false,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_focus_user ON focus_records(user_id, updated_at);

-- 错题索引（错题库 index.json 的同步副本）
CREATE TABLE IF NOT EXISTS errors (
  id          TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  number      TEXT NOT NULL,
  data        JSONB DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT now(),
  version     INT DEFAULT 1,
  deleted     BOOLEAN DEFAULT false,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_errors_user ON errors(user_id, updated_at);

-- 错题组
CREATE TABLE IF NOT EXISTS error_groups (
  id          TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  data        JSONB DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT now(),
  version     INT DEFAULT 1,
  deleted     BOOLEAN DEFAULT false,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_egroups_user ON error_groups(user_id, updated_at);

-- 笔记/知识库文件（工作区 .md 内容：错题正文、作文、分数预测、README、_sidebar 等）
-- 每条记录对应一个工作区文件，path 为相对路径（业务主键）
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  content     TEXT DEFAULT '',
  updated_at  TIMESTAMPTZ DEFAULT now(),
  version     INT DEFAULT 1,
  deleted     BOOLEAN DEFAULT false,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id, updated_at);

-- 应用设置（config.json 的部分字段：考试配置、昵称、自定义提示词、主题等）
-- 每条记录一个配置键，value 为 JSON 字符串
CREATE TABLE IF NOT EXISTS settings (
  id          TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       JSONB DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT now(),
  version     INT DEFAULT 1,
  deleted     BOOLEAN DEFAULT false,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_settings_user ON settings(user_id, updated_at);
`;

async function init() {
  try {
    await pool.query(SCHEMA);
    console.log('✅ 数据库表创建完成');
  } catch (e) {
    console.error('❌ 数据库初始化失败:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

init();
