import { parsePartialIntent, groqLlm } from '@/src/intent';
import { totalFromUnit } from '@/src/spec';
import { GroqError } from '@/src/groq';
import { ClientError, jsonResponse, requireJsonContentType, withErrorHandling } from '@/src/api-shared';

export async function POST(req: Request) {
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  return withErrorHandling(async () => {
    const body = await req.json();
    const text = String(body?.text ?? '').trim();
    const context = body?.context;
    if (!text) return jsonResponse(400, { error: 'Missing "text"' });

    try {
      let { asset, quantity, unitFloorUsd, floorTotalUsd, horizonDays, missingFields, fieldErrors } =
        await parsePartialIntent(text, groqLlm());

      // If an existing goal is active and the user is modifying it (e.g. "what about 2300 for 10 weeks"),
      // inherit unstated fields from the current goal.
      if (context?.goal) {
        if (asset == null && (context.goal.asset === 'ETH' || context.goal.asset === 'BTC')) {
          asset = context.goal.asset;
          missingFields = missingFields.filter((f) => f !== 'asset');
        }
        if (quantity == null && typeof context.goal.quantity === 'number' && context.goal.quantity > 0) {
          quantity = context.goal.quantity;
          missingFields = missingFields.filter((f) => f !== 'quantity');
        }
        if (unitFloorUsd == null && typeof context.goal.floorUsd === 'number' && context.goal.floorUsd > 0) {
          unitFloorUsd = context.goal.floorUsd;
          missingFields = missingFields.filter((f) => f !== 'floor');
        }
        if (horizonDays == null && typeof context.goal.days === 'number' && context.goal.days > 0) {
          horizonDays = context.goal.days;
          missingFields = missingFields.filter((f) => f !== 'horizonDays');
        }
        if (quantity != null && unitFloorUsd != null) {
          floorTotalUsd = totalFromUnit(unitFloorUsd, quantity);
          delete fieldErrors.floor;
        }
      }

      return jsonResponse(200, {
        spec: { asset, quantity, unitFloorUsd, floorTotalUsd, horizonDays },
        missingFields,
        fieldErrors,
      });
    } catch (e: any) {
      // If the message is a question or conversational remark rather than a protection request,
      // answer the user directly and helpfully instead of failing with a 400 error.
      if (typeof e?.message === 'string' && /Not a protection request/i.test(e.message)) {
        try {
          const llm = groqLlm();
          const goalContext = context?.goal
            ? `User currently has an active protection goal of ${context.goal.quantity} ${context.goal.asset} with a $${context.goal.floorUsd} protected price for ${context.goal.days} days.`
            : 'User does not have an active protection goal yet.';
          const cardContext = context?.card ? `User is viewing the "${context.card}" step.` : '';

          const answerSystem = `You are Payung, an AI assistant helping a user protect crypto value using on-chain put options on Base.
${goalContext}
${cardContext}

Rules:
- Answer the user's question concisely, clearly, and conversationally in 1-2 sentences.
- Never invent hypothetical dollar amounts, strikes, or dates.
- Keep tone direct, plain, and friendly. Talk about protection and dollars, not complex finance jargon.
- If they are asking how to proceed, guide them to state an amount, protected price, and timeframe (or tap an option above).`;

          const answer = await llm(answerSystem, text);
          if (answer && answer.trim()) {
            return jsonResponse(200, {
              answer: answer.trim(),
              spec: { asset: null, quantity: null, unitFloorUsd: null, floorTotalUsd: null, horizonDays: null },
              missingFields: [],
              fieldErrors: {},
            });
          }
        } catch {
          // Fallback if conversational call fails
          return jsonResponse(200, {
            answer:
              "I'm here to help you protect your crypto. You can state an amount, a protected price, and how long to protect it, or tap an option above.",
            spec: { asset: null, quantity: null, unitFloorUsd: null, floorTotalUsd: null, horizonDays: null },
            missingFields: [],
            fieldErrors: {},
          });
        }
      }

      if (e instanceof GroqError || (typeof e?.status === 'number' && e.status >= 500)) {
        throw e;
      }
      throw new ClientError(e?.message ?? String(e));
    }
  });
}
