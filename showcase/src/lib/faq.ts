/** AI Agents FAQ — keep in sync with app `aiAgentsFaq.topics` (en). */
export type FaqItem = {
  id: string;
  title: string;
  body: string;
};

export const SHOWCASE_FAQ: FaqItem[] = [
  {
    id: 'whatCanItDo',
    title: 'What can the agent do?',
    body: 'Once live, your agent can open long or short positions on the assets you pick, then manage them over time.\n\nOn open positions it can hold, add, trim, flip direction, or fully exit — including cutting losers early. It can also place stop-loss protection and tighten stops as a trade moves in your favor (it never loosens risk).',
  },
  {
    id: 'howDecisions',
    title: 'How does the AI make decisions?',
    body: 'Each cycle the agent builds a market picture from live data — price action, open interest, liquidations, options, funding, and related flow signals — plus session/macro calendar context (time of day / macro events).\n\nThat context is sent to the AI model you chose. The model proposes an action; HyperTrade still enforces your rules (assets, leverage, notional caps) before any order is sent.',
  },
  {
    id: 'monitorCadence',
    title: 'How often does the agent check open positions?',
    body: 'All agents look for new entries about once an hour. How often an open trade is re-managed depends on the trading horizon:\n\n• Scalper: about every hour\n• Swing: about every hour\n• Investor: about every 4 hours by default — mid-window checks are skipped unless risk fires (for example liquidation distance, near stop, earnings window, or a weakened thesis)\n\nBetween checks, exchange stop-loss orders still protect open positions.',
  },
  {
    id: 'myMoney',
    title: 'Does it trade with my money?',
    body: 'Yes — when you create an agent in the app, it uses your trade balance within the notional caps you set.\n\nIt signs orders with an agent key that you approve. That key can place trades but cannot withdraw funds from your account.\n\nThe agents on this showcase page are house-funded demos, not trading your wallet.',
  },
  {
    id: 'areAgentsFree',
    title: 'Are AI agents free to create?',
    body: "Yes — HyperTrade doesn't charge a fee to create or run an agent.\n\nTo activate one, your trade balance (not wallet balance) must hold at least $50. Wallet USDC sitting outside Trade doesn't count until you move it over.",
  },
  {
    id: 'notionalBudget',
    title: 'How does max total notional work?',
    body: "It's the agent's overall notional ceiling — a limit, not a target: the agent sizes by conviction and may use far less than the max. Combined open size (entry plus any adds) still cannot exceed this total.",
  },
  {
    id: 'reasoning',
    title: 'Can I read the reasoning behind decisions?',
    body: 'Yes. On this page, expand items in the Decisions panel for the full reasoning trail.\n\nIn the app, open Reasoning on AI-managed positions in Portfolio, or expand an agent on the AI Agents page to browse recent decisions and summaries.',
  },
  {
    id: 'whichMarkets',
    title: 'Which markets can it trade?',
    body: 'In the app, agents currently focus on crypto perpetual markets (for example BTC, ETH, HYPE, SOL and other majors).\n\nThis showcase may also feature house-funded agents on stock perps — a preview of where the product is heading.',
  },
  {
    id: 'whenThingsFail',
    title: 'What if data or the AI model is down?',
    body: "We don't close or auto-stop the agent on a bad cycle.\n\nOpen positions keep their exchange stops. If market data or the model is unavailable, the agent skips new decisions and retries next cycle. Sustained issues show a Needs attention warning (and a mobile notification if enabled) — you stay in control to pause, stop, or manage the position yourself.",
  },
  {
    id: 'risks',
    title: 'What are the risks?',
    body: 'Trading involves risk of loss. An AI agent can open losing trades, get stopped out, or underperform — the same as manual trading.\n\nSet conservative caps, start small, and revoke anytime. This is not financial advice.',
  },
];
