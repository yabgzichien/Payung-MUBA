import { getSignerAddress, getState } from '@/src/watcher-runtime';
import { jsonResponse, watcherLoopAllowed, withErrorHandling } from '@/src/api-shared';

export async function GET() {
  return withErrorHandling(async () => {
    let address: string | null = null;
    let addressError: string | null = null;
    try {
      address = getSignerAddress();
    } catch (e: any) {
      addressError = e?.shortMessage || e?.message || String(e);
    }
    return jsonResponse(200, { ...getState(), address, addressError, loopAllowed: watcherLoopAllowed() });
  });
}
