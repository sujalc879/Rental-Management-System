import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, test } from 'vitest';
import { decryptArchive, encryptArchive, sha256 } from '../scripts/backup/archive';

test('AES-GCM restores encrypted metadata and rejects tampering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rental-crypto-'));
  try {
    const encrypted = join(dir, 'encrypted');
    const key = randomBytes(32);
    const manifest = { counts: { organizations: '2' }, samples: '0123456789abcdef0123456789abcdef' };
    await encryptArchive(Readable.from([Buffer.from('sample private data')]), encrypted, key, 'test_key', manifest);
    const bytes = await readFile(encrypted);
    expect(bytes.includes(Buffer.from('sample private data'))).toBe(false);
    expect(bytes.includes(Buffer.from('organizations'))).toBe(false);
    const verified = join(dir, 'verified');
    expect(await decryptArchive(encrypted, verified, version => { expect(version).toBe('test_key'); return key; })).toEqual(manifest);
    expect(await readFile(verified, 'utf8')).toBe('sample private data');
    const original = await sha256(createReadStream(encrypted));
    bytes[bytes.length - 17] ^= 1;
    await writeFile(encrypted, bytes);
    expect(await sha256(createReadStream(encrypted))).not.toBe(original);
    await expect(decryptArchive(encrypted, join(dir, 'corrupt'), () => key)).rejects.toBeDefined();
  } finally { await rm(dir, { force: true, recursive: true }); }
});
