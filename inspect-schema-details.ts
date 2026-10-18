import dataSource from './dist/database/data-source.js';
await dataSource.initialize();
try {
    const columns = await dataSource.query(`
    SELECT
      table_name,
      column_name,
      data_type,
      character_maximum_length,
      numeric_precision,
      numeric_scale,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (
        'wallets',
        'wagering_transactions',
        'ledger_entries',
        'processed_messages',
        'outbox_events'
      )
    ORDER BY table_name, ordinal_position
  `);
    const constraints = await dataSource.query(`
    SELECT
      cls.relname AS table_name,
      con.conname AS constraint_name,
      con.contype AS constraint_type,
      pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = cls.relnamespace
    WHERE ns.nspname = 'public'
      AND cls.relname IN (
        'wallets',
        'wagering_transactions',
        'ledger_entries',
        'processed_messages',
        'outbox_events'
      )
    ORDER BY cls.relname, con.conname
  `);
    const indexes = await dataSource.query(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN (
        'wallets',
        'wagering_transactions',
        'ledger_entries',
        'processed_messages',
        'outbox_events'
      )
    ORDER BY tablename, indexname
  `);
    console.log('\\n=== COLUNAS ===');
    console.table(columns);
    console.log('\\n=== RESTRICOES ===');
    console.table(constraints);
    console.log('\\n=== INDICES ===');
    console.table(indexes);
}
finally {
    await dataSource.destroy();
}
