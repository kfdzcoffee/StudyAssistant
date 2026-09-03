// Migration: change record tables from global id PK to composite (user_id, id) PK
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const TABLES = ['words', 'wenyan', 'todos', 'focus_records', 'errors', 'error_groups', 'notes', 'settings'];

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of TABLES) {
      // Drop existing primary key constraint (named <table>_pkey by default)
      await client.query(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${t}_pkey`);
      // Add composite primary key (user_id, id)
      await client.query(`ALTER TABLE ${t} ADD PRIMARY KEY (user_id, id)`);
      console.log(`✅ ${t}: primary key -> (user_id, id)`);
    }
    await client.query('COMMIT');
    console.log('Migration complete');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', e.message);
  } finally {
    client.release();
    await pool.end();
  }
})();
