import 'dotenv/config';
import pg from 'pg';

const db = new pg.Client({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE ?? 'jg_backend_challenge',
});

await db.connect();

try {
  const result = await db.query(`
    SELECT
      c.relname AS table_name,
      t.tgname AS trigger_name,
      pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND NOT t.tgisinternal
      AND c.relname IN (
        'wallets',
        'wagering_transactions',
        'ledger_entries',
        'processed_messages',
        'outbox_events'
      )
    ORDER BY c.relname, t.tgname
  `);

  console.log('=== TRIGGERS DO BANCO ===');
  console.table(result.rows);

  if (result.rows.length === 0) {
    console.log('Nenhum trigger encontrado nas cinco tabelas consultadas.');
  }
} finally {
  await db.end();
}
