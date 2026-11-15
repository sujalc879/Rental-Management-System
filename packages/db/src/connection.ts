export function databaseUrl(value: string | undefined) {
  if (!value) throw new Error('A PostgreSQL connection URL is required');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid PostgreSQL connection URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
    throw new Error('A PostgreSQL URL must name a host and database');
  }
  // node-postgres accepts query parameters that override the authority/path. Refuse
  // these so isolation guards and pg_dump connect to the exact target we validated.
  const targetOverrides = ['host', 'hostaddr', 'port', 'database', 'dbname', 'user', 'password', 'service', 'servicefile'];
  if (targetOverrides.some(key => url.searchParams.has(key))) throw new Error('Put PostgreSQL connection targets in the URL authority and path, not query parameters');
  return url;
}
