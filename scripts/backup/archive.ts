import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

const headerSize = 48;
const tagSize = 16;
const magic = Buffer.from('RNTBK001');
const versionPattern = /^[A-Za-z0-9_-]{1,24}$/;

export const manifestSchema = z.object({
  counts: z.record(z.string(), z.string().regex(/^\d+$/)),
  samples: z.string().regex(/^[a-f0-9]{32}$/),
});
export type Manifest = z.infer<typeof manifestSchema>;

export function parseKey(value: string | undefined) {
  if (!value || !/^[a-f\d]{64}$/i.test(value)) throw new Error('A 256-bit backup key in hex is required');
  return Buffer.from(value, 'hex');
}

export async function sha256(stream: AsyncIterable<Uint8Array>) {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

export async function encryptArchive(input: Readable, destination: string, key: Buffer, version: string, manifest: Manifest) {
  if (!versionPattern.test(version)) throw new Error('Invalid backup key version');
  const header = Buffer.alloc(headerSize);
  magic.copy(header);
  randomBytes(12).copy(header, 8);
  header.write(version, 20, 'ascii');
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(8, 20));
  cipher.setAAD(header);
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  await pipeline(Readable.from((async function* () {
    yield header;
    yield cipher.update(`${JSON.stringify(manifest)}\n`, 'utf8');
    for await (const chunk of input) yield cipher.update(chunk);
    yield cipher.final();
    yield cipher.getAuthTag();
  })()), output);
}

export async function decryptArchive(source: string, destination: string, getKey: (version: string) => Buffer) {
  const fd = await open(source, 'r');
  const header = Buffer.alloc(headerSize);
  const tag = Buffer.alloc(tagSize);
  let bytes: number;
  try {
    bytes = (await fd.stat()).size;
    if (bytes <= headerSize + tagSize || (await fd.read(header, 0, headerSize, 0)).bytesRead !== headerSize ||
      !header.subarray(0, 8).equals(magic) || (await fd.read(tag, 0, tagSize, bytes - tagSize)).bytesRead !== tagSize) throw new Error('Invalid backup archive');
  } finally { await fd.close(); }
  const version = header.subarray(20, 44).toString('ascii').replace(/\0+$/, '');
  if (!versionPattern.test(version)) throw new Error('Invalid backup key version');
  const decipher = createDecipheriv('aes-256-gcm', getKey(version), header.subarray(8, 20));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  let manifest: Manifest | undefined;
  let prefix = Buffer.alloc(0);
  await pipeline(createReadStream(source, { start: headerSize, end: bytes - tagSize - 1 }), decipher,
    async function* (input: AsyncIterable<Buffer>) {
      for await (const chunk of input) {
        if (manifest) { yield chunk; continue; }
        prefix = Buffer.concat([prefix, chunk]);
        const newline = prefix.indexOf(10);
        if (newline < 0) {
          if (prefix.length > 8192) throw new Error('Invalid backup manifest');
          continue;
        }
        if (newline > 8192) throw new Error('Invalid backup manifest');
        manifest = manifestSchema.parse(JSON.parse(prefix.subarray(0, newline).toString('utf8')));
        yield prefix.subarray(newline + 1);
      }
    }, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  if (!manifest) throw new Error('Missing backup manifest');
  return manifest;
}

