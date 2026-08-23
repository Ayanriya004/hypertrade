/** AI Agents FAQ topic ids — keep in sync with `aiAgentsFaq.topics.*` locale keys. */
export const AI_AGENTS_FAQ_TOPIC_IDS = [
  'whatCanItDo',
  'howDecisions',
  'monitorCadence',
  'sharedVsDedicated',
  'switchingTradeAccount',
  'myMoney',
  'areAgentsFree',
  'stayInControl',
  'notionalBudget',
  'existingPosition',
  'manualClose',
  'lossCooldown',
  'marginDust',
  'reasoning',
  'whichMarkets',
  'howManyAgents',
  'agentSlots',
  'whenThingsFail',
  'risks',
] as const;

export type AiAgentsFaqTopicId = (typeof AI_AGENTS_FAQ_TOPIC_IDS)[number];

export function isAiAgentsFaqTopicId(value: string): value is AiAgentsFaqTopicId {
  return (AI_AGENTS_FAQ_TOPIC_IDS as readonly string[]).includes(value);
}
