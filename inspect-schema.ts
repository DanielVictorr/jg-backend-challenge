import dataSource from './dist/database/data-source.js';
await dataSource.initialize();
try {
    const rows = await dataSource.query(`
    SELECT 'wallets' AS table_name, COUNT(*)::int AS total
      FROM wallets
    UNION ALL
    SELECT 'wagering_transactions', COUNT(*)::int
      FROM wagering_transactions
    UNION ALL
    SELECT 'ledger_entries', COUNT(*)::int
      FROM ledger_entries
    UNION ALL
    SELECT 'processed_messages', COUNT(*)::int
      FROM processed_messages
    UNION ALL
    SELECT 'outbox_events', COUNT(*)::int
      FROM outbox_events
    ORDER BY table_name
  `);
    console.table(rows);
}
finally {
    await dataSource.destroy();
}
