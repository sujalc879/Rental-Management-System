export function operatorDestination(destination: string | undefined) {
  if (!destination) return null;
  let url: URL;
  try { url = new URL(destination); } catch { throw new Error('Invalid operator monitoring URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Operator monitoring requires an HTTPS URL without userinfo');
  return url;
}

export async function signalOperator(destination: string | undefined, event: string) {
  const url = operatorDestination(destination);
  if (!url) return;
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event }), signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Operator monitoring endpoint failed');
}
