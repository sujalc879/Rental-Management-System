import { expect, test } from 'vitest';
import { workerErrorDetails } from '../apps/worker/src/logging';

test('reports a Prisma connection failure without its database address or credentials', () => {
  const secret = 'postgresql://owner:private-password@private-host/database';
  const error = Object.assign(new Error(`Cannot connect to ${secret}`), {
    name: 'PrismaClientKnownRequestError', code: 'P2010',
    meta: { driverAdapterError: { cause: { kind: 'DatabaseNotReachable', host: 'private-host', originalMessage: secret } } },
  });
  const details = workerErrorDetails(error);
  expect(details).toMatchObject({ kind: 'PrismaClientKnownRequestError', code: 'P2010', databaseKind: 'DatabaseNotReachable' });
  expect(JSON.stringify(details)).not.toMatch(/postgresql|owner|private-password|private-host/);
});

test('reports SQLSTATE without SQL, parameters or tenant data', () => {
  const error = Object.assign(new Error('SELECT confidential data'), {
    name: 'PrismaClientKnownRequestError', code: 'P2010',
    meta: { code: '42P01', message: 'confidential tenant data',
      driverAdapterError: { cause: { kind: 'TableDoesNotExist', originalCode: '42P01', originalMessage: 'confidential SQL' } } },
  });
  expect(workerErrorDetails(error)).toEqual({
    kind: 'PrismaClientKnownRequestError', code: 'P2010', databaseKind: 'TableDoesNotExist', databaseCode: '42P01',
  });
  expect(JSON.stringify(workerErrorDetails(error))).not.toMatch(/SELECT|confidential|tenant/);
});

test('does not serialize arbitrary thrown payloads or unrecognized error fields', () => {
  expect(workerErrorDetails({ password: 'private-password' })).toMatchObject({ kind: 'unknown' });
  const error = Object.assign(new Error('private-password'), {
    name: 'private-password', code: 'private-password',
    meta: { code: 'private-password', driverAdapterError: { cause: { kind: 'private-password' } } },
  });
  expect(JSON.stringify(workerErrorDetails(error))).toBe('{"kind":"Error"}');
  expect(workerErrorDetails(null)).toMatchObject({ kind: 'unknown' });
});
