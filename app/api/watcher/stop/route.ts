import { stop } from '@/src/watcher-runtime';
import { jsonResponse, withErrorHandling } from '@/src/api-shared';

export async function POST() {
  return withErrorHandling(async () => {
    stop();
    return jsonResponse(200, { stopped: true });
  });
}
