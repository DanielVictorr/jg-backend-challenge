import 'dotenv/config';

import { DataSource } from 'typeorm';

const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE ?? 'jg_backend_challenge',

  entities: [],
  migrations: ['dist/database/migrations/*.js'],

  synchronize: false,
  migrationsRun: false,
});

export default dataSource;