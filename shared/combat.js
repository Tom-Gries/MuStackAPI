import { getCardDefinition } from './catalog.js';

/** Older saved solo battles are still valid; new battles retain a stable target. */
export const combatHumanIds = (combat) => [...new Set(combat.humanIds ?? [combat.humanId])].filter(Boolean);
export const combatEnemyIds = (combat) => [...new Set(combat.ratIds ?? [combat.ratId])].filter(Boolean);
export function humanDamage(world, human) {
  const tool = world.cards.find((card) => card.id === human.toolId && card.equippedTo === human.id);
  return 1 + (tool ? getCardDefinition(world, tool.type)?.effects?.find((effect) => effect.kind === 'weapon')?.damage || 0 : 0);
}
