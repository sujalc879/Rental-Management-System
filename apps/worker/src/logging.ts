const errorNames = new Set([
  'PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError',
  'PrismaClientInitializationError', 'PrismaClientValidationError',
]);
const databaseKinds = new Set([
  'DatabaseNotReachable', 'SocketTimeout', 'ConnectionClosed', 'TlsConnectionError',
  'AuthenticationFailed', 'DatabaseAccessDenied', 'DatabaseDoesNotExist',
  'TableDoesNotExist', 'ColumnNotFound', 'TooManyConnections', 'postgres',
]);

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

export function workerErrorDetails(error: unknown) {
  const details = object(error);
  const meta = object(details?.meta);
  const adapter = object(meta?.driverAdapterError);
  const database = object(adapter?.cause);
  const databaseCode = database?.originalCode ?? database?.code ?? meta?.code;
  // Raw errors, messages and metadata can contain connection URLs, SQL and tenant data.
  return {
    kind: error instanceof Error ? errorNames.has(error.name) ? error.name : 'Error' : 'unknown',
    code: typeof details?.code === 'string' && /^P\d{4}$/.test(details.code) ? details.code : undefined,
    databaseKind: typeof database?.kind === 'string' && databaseKinds.has(database.kind) ? database.kind : undefined,
    databaseCode: typeof databaseCode === 'string' && /^[0-9A-Z]{5}$/.test(databaseCode) ? databaseCode : undefined,
  };
}
