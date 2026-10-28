import { CONFIG, DEFAULT_CREATURE, DEFAULT_RAT_DROPS, getCardDefinition } from './catalog.js';

export function creatureProfile(world, card) {
  const definition = getCardDefinition(world, typeof card === 'string' ? card : card?.type);
  if ((typeof card === 'string' ? card : card?.type) === 'rat') return definition?.creature || { ...DEFAULT_CREATURE, aggressive: true, behavior: 'seek', speed: CONFIG.ratSpeed, hp: CONFIG.ratHp, damage: CONFIG.ratDamage, attackInterval: CONFIG.attackInterval };
  return definition?.category === 'creature' ? { ...DEFAULT_CREATURE, ...definition.creature } : null;
}

export const isCreature = (world, card) => Boolean(creatureProfile(world, card));

export function deathDropsFor(world, card) {
  const type = typeof card === 'string' ? card : card?.type;
  return getCardDefinition(world, type)?.deathDrops ?? (type === 'rat' ? DEFAULT_RAT_DROPS : { chance: 0, outputs: [] });
}
