// scripts/eval-live.ts
// Hits Groq for real and reports a pass rate on natural-language phrasing,
// including Bahasa Malaysia — the product is named for a Malay word and its
// first users are likely to type in it.
import 'dotenv/config';
import { groqLlm, parsePartialIntent } from '../src/intent.js';

const SENTENCES: { text: string; asset: string; quantity: number; horizonDays: number }[] = [
  { text: 'I have 1 ETH and need it worth at least $2,300 in two weeks', asset: 'ETH', quantity: 1, horizonDays: 14 },
  { text: 'protect 2 BTC, I cannot let it fall below $62,000 each, for a month', asset: 'BTC', quantity: 2, horizonDays: 30 },
  { text: 'tuition is due end of next week, I hold 3 ETH and need $7,000 total', asset: 'ETH', quantity: 3, horizonDays: 10 },
  { text: 'Saya ada 1 ETH, saya perlu nilainya sekurang-kurangnya $2,300 dalam dua minggu', asset: 'ETH', quantity: 1, horizonDays: 14 },
  { text: 'Saya nak lindungi 2 BTC saya untuk sebulan, jangan jatuh bawah $62,000 satu', asset: 'BTC', quantity: 2, horizonDays: 30 },
];

async function main() {
  const llm = groqLlm();
  let pass = 0;
  for (const s of SENTENCES) {
    try {
      const got = await parsePartialIntent(s.text, llm);
      const ok = got.asset === s.asset && got.quantity === s.quantity && got.horizonDays === s.horizonDays;
      if (ok) pass++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.text}`);
      if (!ok) console.log(`      got ${JSON.stringify({ asset: got.asset, quantity: got.quantity, horizonDays: got.horizonDays })}`);
    } catch (e: any) {
      console.log(`ERROR ${s.text}\n      ${e?.message ?? e}`);
    }
  }
  console.log(`\n${pass}/${SENTENCES.length} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
