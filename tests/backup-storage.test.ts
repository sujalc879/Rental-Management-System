import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { sha256 } from '../scripts/backup/archive';
import { storage } from '../scripts/backup/storage';

const { send, configure } = vi.hoisted(() => ({ send: vi.fn<(command: unknown) => Promise<Record<string, unknown>>>(), configure: vi.fn() }));
vi.mock('@aws-sdk/client-s3', async importOriginal => ({
  ...await importOriginal<typeof import('@aws-sdk/client-s3')>(),
  S3Client: class { constructor(options: unknown) { configure(options); } send = send; },
}));

let dir: string;
let file: string;
let digest: string;
const bytes = randomBytes(128);
const key = `daily/2026-11-07T00-00-00-000Z-${crypto.randomUUID()}.rentbk`;

beforeEach(async () => {
  send.mockReset();
  configure.mockReset();
  dir = await mkdtemp(join(tmpdir(), 'rental-storage-'));
  file = join(dir, 'encrypted.rentbk');
  await writeFile(file, bytes, { mode: 0o600 });
  digest = await sha256(createReadStream(file));
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('BACKUP_LOCAL_DIR', '');
  vi.stubEnv('BACKUP_S3_ENDPOINT', 'https://example.invalid');
  vi.stubEnv('BACKUP_S3_BUCKET', 'private-test-bucket');
  vi.stubEnv('BACKUP_S3_REGION', '');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

function mockStorage(corrupt = false, wrongMetadata = false) {
  send.mockImplementation(async command => {
    if (command instanceof PutObjectCommand) {
      const chunks: Buffer[] = [];
      for await (const chunk of command.input.Body as Readable) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(bytes);
      expect(command.input.IfNoneMatch).toBe('*');
      return {};
    }
    if (command instanceof HeadObjectCommand) return { ContentLength: bytes.length,
      Metadata: { sha256: wrongMetadata ? 'wrong' : digest, 'key-version': 'test' },
    };
    if (command instanceof GetObjectCommand) return { Body: Readable.from([corrupt ? Buffer.from('corrupted') : bytes]) };
    throw new Error('Unexpected S3 command');
  });
}

test('verifies both independently named daily and monthly off-site copies by metadata and readback', async () => {
  mockStorage();
  const store = storage();
  await store.upload(key, file, digest, 'test');
  await store.upload(key.replace('daily/', 'monthly/'), file, digest, 'test');
  expect(store.kind).toBe('OFFSITE');
  expect(send.mock.calls.map(([command]) => command instanceof PutObjectCommand ? command.input.Key : null).filter(Boolean))
    .toEqual([key, key.replace('daily/', 'monthly/')]);
  expect(send).toHaveBeenCalledTimes(6);
  const originalId = store.id;
  vi.stubEnv('BACKUP_S3_BUCKET', 'another-private-bucket');
  expect(storage().id).not.toBe(originalId);
});

test('rejects successful uploads whose metadata or downloaded checksum does not match', async () => {
  mockStorage(false, true);
  await expect(storage().upload(key, file, digest, 'test')).rejects.toThrow('metadata verification failed');
  expect(send).toHaveBeenCalledTimes(2);
  send.mockReset();
  mockStorage(true);
  await expect(storage().upload(key, file, digest, 'test')).rejects.toThrow('checksum mismatch');
});

test('propagates storage outages and never treats a development copy as off-site', async () => {
  send.mockRejectedValue(new Error('Storage unavailable'));
  await expect(storage().upload(key, file, digest, 'test')).rejects.toThrow('Storage unavailable');
  vi.stubEnv('BACKUP_LOCAL_DIR', join(dir, 'store'));
  const store = storage();
  expect(store.kind).toBe('LOCAL_DEVELOPMENT');
  vi.stubEnv('BACKUP_LOCAL_DIR', join(dir, 'another-store'));
  expect(storage().id).not.toBe(store.id);
  await store.upload(key, file, digest, 'test');
  await store.download(key, join(dir, 'download'));
  expect(await readFile(join(dir, 'download'))).toEqual(bytes);
  await expect(store.upload(key, file, digest, 'test')).rejects.toMatchObject({ code: 'EEXIST' });
  await expect(store.download('../private', join(dir, 'escaped'))).rejects.toThrow('Invalid backup object key');
  vi.stubEnv('NODE_ENV', 'production');
  expect(() => storage()).toThrow('development only');
});

test('requires the AWS bucket region while preserving the existing R2 auto-region default', () => {
  storage();
  expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ region: 'auto' }));
  vi.stubEnv('BACKUP_S3_ENDPOINT', 'https://s3.ap-south-1.amazonaws.com');
  expect(() => storage()).toThrow('AWS bucket region');
  vi.stubEnv('BACKUP_S3_REGION', 'ap-south-1');
  const aws = storage();
  expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ region: 'ap-south-1', endpoint: 'https://s3.ap-south-1.amazonaws.com/' }));
  expect(aws.kind).toBe('OFFSITE');
  vi.stubEnv('BACKUP_S3_REGION', 'another-region');
  expect(storage().id).toBe(aws.id);
});

test('rejects unsafe or malformed endpoints without revealing embedded secrets', () => {
  for (const endpoint of ['secret-invalid-endpoint', 'https://operator:secret-password@example.invalid', 'https://example.invalid?token=secret-value', 'https://example.invalid#secret-value', 'file:///tmp/archive']) {
    vi.stubEnv('BACKUP_S3_ENDPOINT', endpoint);
    try { storage(); throw new Error('Unsafe endpoint was accepted'); }
    catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('private HTTPS S3-compatible endpoint');
      expect((error as Error).message).not.toContain('secret');
    }
  }
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('BACKUP_S3_ENDPOINT', 'http://example.invalid');
  expect(() => storage()).toThrow('private HTTPS');
  vi.stubEnv('BACKUP_S3_ENDPOINT', 'https://example.invalid');
  vi.stubEnv('BACKUP_S3_REGION', 'invalid/secret-region');
  expect(() => storage()).toThrow('Invalid backup S3 region');
});
