import { afterEach, expect, test, vi } from 'vitest';
import { operatorDestination, signalOperator } from '../scripts/monitoring';

afterEach(() => { vi.restoreAllMocks(); });

test('rejects insecure or credential-bearing monitoring URLs without exposing them', () => {
  expect(operatorDestination(undefined)).toBeNull();
  expect(() => operatorDestination('http://operator.example/check')).toThrow('HTTPS');
  expect(() => operatorDestination('https://owner:private-secret@operator.example/check')).toThrow('without userinfo');
  try { operatorDestination('private-secret'); } catch (error) {
    expect(String(error)).toBe('Error: Invalid operator monitoring URL');
  }
});

test('does not send an external signal when development monitoring is unconfigured', async () => {
  const send = vi.spyOn(globalThis, 'fetch');
  await signalOperator(undefined, 'worker.healthy');
  expect(send).not.toHaveBeenCalled();
});

test('rejects failed monitoring responses and forbids redirects with a minimal event payload', async () => {
  const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
  await expect(signalOperator('https://operator.example/check', 'worker.healthy')).rejects.toThrow('endpoint failed');
  expect(send).toHaveBeenCalledWith(new URL('https://operator.example/check'), expect.objectContaining({
    method: 'POST', redirect: 'error', body: '{"event":"worker.healthy"}',
  }));
});
