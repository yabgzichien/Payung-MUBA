import { parsePartialIntent, groqLlm } from '@/src/intent';
import { GroqError } from '@/src/groq';
import { ClientError, jsonResponse, requireJsonContentType, withErrorHandling } from '@/src/api-shared';

export async function POST(req: Request) {
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  return withErrorHandling(async () => {
    const { text } = await req.json();
    if (!text) return jsonResponse(400, { error: 'Missing "text"' });
    try {
      const { asset, quantity, unitFloorUsd, floorTotalUsd, horizonDays, missingFields, fieldErrors } =
        await parsePartialIntent(String(text), groqLlm());
      // 200 even when fields are missing/invalid: the sentence box highlights
      // those fields instead of blocking on a top-level error. Only a wholly
      // unusable reply (not a protection request, or no JSON at all) is a 400.
      return jsonResponse(200, {
        spec: { asset, quantity, unitFloorUsd, floorTotalUsd, horizonDays },
        missingFields,
        fieldErrors,
      });
    } catch (e: any) {
      if (e instanceof GroqError || (typeof e?.status === 'number' && e.status >= 500)) {
        throw e;
      }
      throw new ClientError(e?.message ?? String(e));
    }
  });
}
