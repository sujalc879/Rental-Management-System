import { expect, test } from 'vitest';
import { databaseUrl } from '../packages/db/src/connection';
import { directUrl } from '../scripts/backup/postgres';
import { testDatabase } from './local-db';

test('refuses query overrides that could bypass isolated test and restore target guards', () => {
  for (const parameter of ['host', 'hostaddr', 'port', 'database', 'dbname', 'user', 'password', 'service', 'servicefile']) {
    const value = `postgresql://local@127.0.0.1:55439/rental_test?${parameter}=untrusted`;
    expect(() => databaseUrl(value)).toThrow('query parameters');
    expect(() => directUrl(value)).toThrow('query parameters');
    expect(() => testDatabase(value)).toThrow('query parameters');
  }
});

test('accepts explicit PostgreSQL targets and TLS parameters without changing credentials', () => {
  const value = 'postgresql://owner:encoded%40password@example.invalid/db?sslmode=verify-full&channel_binding=require';
  expect(databaseUrl(value).href).toBe(value);
  expect(() => databaseUrl('https://example.invalid/db')).toThrow('PostgreSQL');
  expect(() => databaseUrl('postgresql://owner:private-secret@[invalid/database')).toThrow('Invalid PostgreSQL connection URL');
  expect(() => directUrl('postgresql://owner@example-pooler.invalid/db')).toThrow('direct PostgreSQL');
});
