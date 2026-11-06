import { openDatabase } from '../packages/db/src/index';

export function testDatabase(value = process.env.TEST_DATABASE_URL) {
  if (!value) throw new Error('TEST_DATABASE_URL must point to a migrated local rental_test database');
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', 'db'].includes(url.hostname) || !/^\/rental_test(?:_[a-z0-9_]+)?$/.test(url.pathname)) throw new Error('Tests require a disposable local rental_test database');
  return openDatabase(value);
}
