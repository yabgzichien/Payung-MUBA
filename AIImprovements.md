

The project isn't quite enough for Track 02 yet, but the problems are specific and fixable.

🚨 Biggest blocker

You need to execute at least one real trade using live pricing.
The current $10 simulated fill doesn't count.
Execute a real fillOrder() with your wallet, save the transaction hash, and show the receipt in the UI.

🤖 Main AI weakness

Right now, the LLM is basically just a parser: it converts a sentence into 4 fields.
A judge could replace the LLM with a normal form and the app would still work.
The AI needs to make decisions about what to do next, while still never inventing numbers.
Best improvements, ranked
Add AI tool-calling ⭐
Let the LLM decide which tools to call and in what order.
Example: fetch options → find candidates → quote → compare → recommend.
All prices/numbers still come from your tools, so your anti-hallucination guarantee stays intact.
Add an autonomous re-hedging loop
Monitor existing positions, prices, and options.
Automatically decide when a position should be rolled/hedged.
Apply strict limits like max spending and allowed assets.
This makes Payung feel like a real autonomous agent, not just an AI interface.
Multi-turn conversations
Instead of showing a form when information is missing, the AI asks questions naturally.
It can remember the user's answers and find alternatives when the exact request isn't available.
Grounded AI explanations
Let the LLM explain recommendations in natural language.
Add a check ensuring every number it says actually came from your tools.
This makes your "AI cannot hallucinate prices" claim technically enforced.
Build an evaluation/test set
Test ambiguous requests, missing information, different phrasings, and Bahasa Malaysia.
Run these tests automatically in CI.
Optional: MCP server
Expose Payung's tools through MCP so judges can interact with the agent through Claude Desktop.
What NOT to do

❌ Don't add:

Price prediction
Sentiment analysis
AI guessing the best strike

Your strongest differentiator is AI that makes decisions using real on-chain data without hallucinating financial numbers.

Recommended order

Real trade → Tool-calling AI → Autonomous re-hedging → Grounded narration

If you implement those, Payung changes from:

"An app where AI converts natural language into an options request"

to:

"An agent that perceives market data, decides what to do, executes trades, and can continue managing the position."