import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, copyFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { sha256 } from './archive';

export const objectName = /^(daily|monthly)\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f\d-]{36}\.rentbk$/;

function checkedKey(key: string) {
  if (!objectName.test(key)) throw new Error('Invalid backup object key');
  return key;
}

export function storage() {
  const local = process.env.BACKUP_LOCAL_DIR;
  if (local) {
    if (process.env.NODE_ENV === 'production') throw new Error('Local backup storage is for development only');
    return {
      kind: 'LOCAL_DEVELOPMENT' as const,
      id: createHash('sha256').update(`local:${resolve(local)}`).digest('hex'),
      async upload(key: string, file: string, digest: string) {
        const path = join(local, checkedKey(key));
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await copyFile(file, path, constants.COPYFILE_EXCL);
        if (await sha256(createReadStream(path)) !== digest) throw new Error('Local archive checksum mismatch');
      },
      async download(key: string, file: string) { await copyFile(join(local, checkedKey(key)), file, constants.COPYFILE_EXCL); },
    };
  }
  const endpoint = process.env.BACKUP_S3_ENDPOINT;
  const Bucket = process.env.BACKUP_S3_BUCKET;
  let destination: URL;
  try {
    destination = new URL(endpoint || '');
    if (!Bucket || destination.username || destination.password || destination.search || destination.hash ||
      (destination.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && destination.protocol === 'http:'))) throw new Error();
  } catch { throw new Error('A private HTTPS S3-compatible endpoint and bucket without embedded credentials are required'); }
  const region = process.env.BACKUP_S3_REGION?.trim() || 'auto';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(region) || region.length > 64) throw new Error('Invalid backup S3 region');
  if (region === 'auto' && /(?:^|\.)amazonaws\.com(?:\.cn)?$/.test(destination.hostname)) {
    throw new Error('Set BACKUP_S3_REGION to the AWS bucket region');
  }
  const client = new S3Client({ endpoint: destination.href, region, forcePathStyle: true, maxAttempts: 2,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    kind: 'OFFSITE' as const,
    id: createHash('sha256').update(`s3:${destination.href}:${Bucket}`).digest('hex'),
    async upload(Key: string, file: string, digest: string, version: string) {
      checkedKey(Key);
      const bytes = (await stat(file)).size;
      if (bytes > 4 * 1024 ** 3) throw new Error('Archive exceeds the single-upload size limit');
      await client.send(new PutObjectCommand({ Bucket, Key, Body: createReadStream(file), ContentLength: bytes,
        ContentType: 'application/octet-stream', IfNoneMatch: '*', Metadata: { sha256: digest, 'key-version': version },
      }), { abortSignal: AbortSignal.timeout(30 * 60_000) });
      const head = await client.send(new HeadObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(30_000) });
      if (head.ContentLength !== bytes || head.Metadata?.sha256 !== digest || head.Metadata?.['key-version'] !== version) throw new Error('Off-site metadata verification failed');
      const read = await client.send(new GetObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(30 * 60_000) });
      if (!(read.Body instanceof Readable) || await sha256(read.Body) !== digest) throw new Error('Off-site archive checksum mismatch');
    },
    async download(Key: string, file: string) {
      checkedKey(Key);
      const result = await client.send(new GetObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(30 * 60_000) });
      if (!(result.Body instanceof Readable)) throw new Error('Missing archive body');
      await pipeline(result.Body, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    },
  };
}
