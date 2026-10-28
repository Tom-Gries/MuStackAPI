import { CONFIG, PACKS, getCatalog, getCardDefinition, getRecipes, getPacks, applyCatalogCommand } from './catalog.js';
import { creatureProfile, deathDropsFor, isCreature } from './creatures.js';
import { combatEnemyIds, combatHumanIds, humanDamage } from './combat.js';

// The backend owns revision/CAS and command IDs. This module is deterministic
// with an injected clock and rng, and performs no I/O or interval ticking.
const clone = (value) => JSON.parse(JSON.stringify(value));
const id = (world, prefix = 'c') => `${prefix}${world.nextId++}`;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const alive = (card) => card?.type === 'human' && card.hp > 0;
const normalCards = (cards) => cards.filter((card) => !card.equippedTo);
const sameIds = (a, b) => [...a].sort().join('|') === [...b].sort().join('|');
const findCard = (world, cardId) => world.cards.find((card) => card.id === cardId);
const effectOf = (world, cardType, kind) => getCardDefinition(world, cardType)?.effects?.find((effect) => effect.kind === kind);

function requireCard(world, cardId) {
  const card = findCard(world, cardId);
  if (!card) throw new Error('Diese Karte ist nicht mehr vorhanden.');
  return card;
}

function position(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Ungültige Kartenposition.');
  return {
    x: clamp(x, 24, CONFIG.worldWidth - CONFIG.cardWidth - 24),
    y: clamp(y, 24, CONFIG.worldHeight - CONFIG.cardHeight - 24),
  };
}

// Generated cards must not look like stacks while having unrelated stack IDs.
// Manual placement is handled by move/targetId; this only places new cards.
function freePosition(world, x, y) {
  const wanted = position(x, Math.max(112, y));
  const stacks = new Map();
  for (const card of normalCards(world.cards)) {
    if (!stacks.has(card.stackId)) stacks.set(card.stackId, []);
    stacks.get(card.stackId).push(card);
  }
  const occupied = [...stacks.values()].map((cards) => {
    const base = cards.find((card) => card.type === 'rat') || cards[0];
    const point = base.motion ? ratPosition(base, world.clock.elapsed) : base;
    return { x: point.x, y: point.y, width: CONFIG.cardWidth, height: CONFIG.cardHeight + (cards.length - 1) * CONFIG.stackOffset };
  });
  const clear = (point) => occupied.every((area) => point.x + CONFIG.cardWidth + 10 <= area.x
    || point.x >= area.x + area.width + 10
    || point.y + CONFIG.cardHeight + 10 <= area.y
    || point.y >= area.y + area.height + 10);
  if (clear(wanted)) return wanted;
  const visited = new Set([`${wanted.x}:${wanted.y}`]);
  const stepX = CONFIG.cardWidth + 24;
  const stepY = CONFIG.cardHeight + 24;
  for (let radius = 1; radius <= Math.ceil(CONFIG.worldWidth / stepX); radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const candidate = position(wanted.x + dx * stepX, Math.max(112, wanted.y + dy * stepY));
        const key = `${candidate.x}:${candidate.y}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (clear(candidate)) return candidate;
      }
    }
  }
  // With no card limit the table can fill up; manual stacks remain available.
  return wanted;
}

function addCard(world, type, x, y, extra = {}) {
  const point = extra.stackId ? position(x, y) : freePosition(world, x, y);
  const card = { id: id(world), type, ...point, order: 0, ...extra };
  card.stackId ??= card.id;
  const source = effectOf(world, type, 'source');
  if (source) card.remaining ??= source.uses;
  const creature = creatureProfile(world, type);
  if (creature) card.hp ??= creature.hp;
  if (type === 'human') card.hp ??= CONFIG.humanHp;
  if (type === 'piggyBank') card.gold ??= 0;
  if (type === 'pack') {
    const pack = getPacks(world).find((definition) => definition.id === extra.packId) || getPacks(world).find((definition) => definition.id === 'basic') || PACKS[0];
    card.packId ??= pack.id;
    card.packName ??= pack.name;
    card.packColor ??= pack.color;
    card.packSize ??= pack.size;
    card.packContents ??= clone(pack.contents);
    card.cardsLeft ??= card.packSize;
  }
  if (type === 'field') card.readyAt ??= world.clock.lastAt + CONFIG.fieldHarvestInterval;
  world.cards.push(card);
  return card;
}

function stackCards(world, stackId) {
  return world.cards.filter((card) => card.stackId === stackId).sort((a, b) => a.order - b.order);
}

function tidyStacks(world) {
  const stacks = new Map();
  for (const card of world.cards) {
    if (card.equippedTo && !alive(findCard(world, card.equippedTo))) delete card.equippedTo;
    if (!stacks.has(card.stackId)) stacks.set(card.stackId, []);
    stacks.get(card.stackId).push(card);
  }
  for (const cards of stacks.values()) {
    const base = normalCards(cards).sort((a, b) => a.order - b.order)[0] || cards[0];
    normalCards(cards).sort((a, b) => a.order - b.order).forEach((card, order) => {
      card.order = order;
      card.x = base.x;
      card.y = base.y;
    });
    for (const tool of cards.filter((card) => card.equippedTo)) {
      const human = findCard(world, tool.equippedTo);
      tool.x = human.x;
      tool.y = human.y;
      tool.order = human.order;
    }
  }
}

function removeCards(world, cardIds) {
  const removed = new Set(cardIds);
  for (const card of world.cards) {
    if (removed.has(card.toolId)) delete card.toolId;
  }
  world.cards = world.cards.filter((card) => !removed.has(card.id));
  tidyStacks(world);
}

function scatter(world, type, count, x, y) {
  const result = [];
  for (let index = 0; index < count; index++) {
    result.push(addCard(world, type, x + (index % 4) * 145, y + Math.floor(index / 4) * 42));
  }
  return result;
}

function addOutput(world, type, anchor, x, y, extra = {}) {
  const previous = world.cards.find((card) => card.type === type && card.outputFromId === anchor.id
    && card.outputAnchorX === anchor.x && card.outputAnchorY === anchor.y
    && card.x === card.outputOriginX && card.y === card.outputOriginY
    && stackCards(world, card.stackId).every((member) => member.type === type && member.outputFromId === anchor.id));
  const details = { outputFromId: anchor.id, outputAnchorX: anchor.x, outputAnchorY: anchor.y, ...extra };
  const output = previous
    ? addCard(world, type, previous.x, previous.y, { ...details, stackId: previous.stackId, order: normalCards(stackCards(world, previous.stackId)).length })
    : addCard(world, type, x, y, details);
  output.outputOriginX = output.x;
  output.outputOriginY = output.y;
  return output;
}

function packRemaining(pack) {
  const size = pack.packSize ?? CONFIG.packSize;
  return Number.isInteger(pack.cardsLeft) ? clamp(pack.cardsLeft, 0, size) : size;
}

function weightedChoice(entries, rng) {
  const roll = clamp(rng(), 0, 1 - Number.EPSILON) * entries.reduce((total, entry) => total + entry.weight, 0);
  let cumulative = 0;
  return entries.find((entry) => (cumulative += entry.weight) > roll) || entries.at(-1);
}

function drawPackCard(world, pack, x, y, rng, now) {
  // Old packages retain the original three-card distribution as well.
  const result = weightedChoice(pack.packContents || PACKS[0].contents, rng);
  return addCard(world, result.type, x, y, result.type === 'field' ? { readyAt: now + CONFIG.fieldHarvestInterval } : {});
}

export function createWorld(now = Date.now()) {
  const world = {
    id: 'shared', schemaVersion: 1, revision: 0, nextId: 1,
    shopPaid: 0, shopPayments: { basic: 0 }, catalog: clone(getCatalog()), clock: { elapsed: 0, lastAt: now }, cards: [], players: [], jobs: [], combats: [],
  };
  const first = addCard(world, 'gold', 590, 160);
  for (let index = 1; index < CONFIG.startingGold; index++) {
    addCard(world, 'gold', first.x, first.y, { stackId: first.stackId, order: index });
  }
  return world;
}

export function joinPlayer(world, name, now = Date.now()) {
  if (typeof name !== 'string') throw new Error('Bitte gib deinen Namen ein.');
  const cleaned = name.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length > 24 || /[\u0000-\u001f\u007f]/u.test(cleaned)) {
    throw new Error('Dein Name muss zwischen 1 und 24 Zeichen lang sein.');
  }
  const nameKey = cleaned.toLocaleLowerCase('de-DE');
  const existing = world.players.find((player) => player.nameKey === nameKey);
  if (existing) return existing;
  const player = { id: id(world, 'p'), name: cleaned, nameKey, joinedAt: now };
  const index = world.players.length;
  const human = addCard(world, 'human', 340 + (index % 5) * 170, 180 + Math.floor(index / 5) * 240, {
    name: cleaned, ownerId: player.id, hp: CONFIG.humanHp,
  });
  player.cardId = human.id;
  world.players.push(player);
  reconcile(world, now);
  return player;
}

function detachTool(world, human) {
  const tool = findCard(world, human.toolId);
  delete human.toolId;
  if (!tool) return;
  delete tool.equippedTo;
  tool.stackId = tool.id;
  tool.order = 0;
  Object.assign(tool, position(human.x + 155, human.y + 35));
}

function moveCards(world, command, now, rng) {
  const card = requireCard(world, command.cardId);
  if (creatureProfile(world, card)?.aggressive) throw new Error('Angreifende Lebewesen bewegen sich von selbst.');
  if (card.motion) {
    const current = ratPosition(card, world.clock.elapsed);
    for (const member of stackCards(world, card.stackId)) Object.assign(member, current);
    delete card.motion;
  }
  const wasEquipped = Boolean(card.equippedTo);
  const origin = { x: card.x, y: card.y };
  const point = position(command.x, command.y);
  let target = command.targetId ? requireCard(world, command.targetId) : null;
  if (target?.equippedTo) target = requireCard(world, target.equippedTo);
  // Rat x/y are the trajectory origin between authoritative events. Resolve a
  // drop against its visible current position, otherwise a human could miss it.
  if (target && isCreature(world, target) && target.motion) {
    const current = ratPosition(target, world.clock.elapsed);
    for (const member of stackCards(world, target.stackId)) Object.assign(member, current);
  }
  let moving;
  if (card.equippedTo) {
    moving = [card];
  } else if (command.takeAbove) {
    const above = normalCards(stackCards(world, card.stackId)).filter((member) => member.order >= card.order);
    const selectedIds = new Set(above.map((member) => member.id));
    moving = [...above, ...world.cards.filter((member) => member.equippedTo && selectedIds.has(member.equippedTo))];
  } else if (command.split) {
    moving = [card, ...world.cards.filter((other) => other.equippedTo === card.id)];
  } else {
    moving = stackCards(world, card.stackId);
  }
  const material = moving.filter((item) => !item.equippedTo || (wasEquipped && item.id === card.id));
  const movingIds = new Set(moving.map((item) => item.id));
  let message;
  if (moving.some((item) => creatureProfile(world, item)?.aggressive)) throw new Error('Trenne die gewünschte Karte am Namen vom Gegner.');
  if (target && movingIds.has(target.id)) target = null;

  if (command.zone === 'shop') {
    const pack = getPacks(world).find((definition) => definition.id === (command.packId ?? 'basic'));
    if (!pack) throw new Error('Dieses Paket wird nicht mehr im Laden angeboten.');
    const pig = material.length === 1 && material[0].type === 'piggyBank' ? material[0] : null;
    if (!pig && (!material.length || material.some((item) => item.type !== 'gold'))) {
      throw new Error(`Ein ${pack.name} kostet ${pack.price} Gold. Ziehe Gold oder ein ausreichend gefülltes Sparschwein hierher.`);
    }
    world.shopPayments ??= {};
    const previousPaid = pack.id === 'basic' ? (world.shopPaid ?? world.shopPayments.basic) : world.shopPayments[pack.id];
    const paid = Number.isInteger(previousPaid) ? clamp(previousPaid, 0, pack.price - 1) : 0;
    const remainingPrice = pack.price - paid;
    if (pig && pig.gold < remainingPrice) throw new Error(`Im Sparschwein ist nicht genug Gold: ${pig.gold} vorhanden, ${remainingPrice} benötigt.`);
    const deposited = pig ? remainingPrice : Math.min(material.length, remainingPrice);
    world.shopPayments[pack.id] = paid + deposited;
    if (pig) pig.gold -= deposited;
    else removeCards(world, material.slice(0, deposited).map((item) => item.id));
    if (world.shopPayments[pack.id] === pack.price) {
      addCard(world, 'pack', origin.x + 155, origin.y, { packId: pack.id });
      world.shopPayments[pack.id] = 0;
      message = `Ein neues ${pack.name} liegt auf dem Tisch.`;
    } else {
      message = `${deposited} Gold eingezahlt. Noch ${pack.price - world.shopPayments[pack.id]} Gold.`;
    }
    if (pack.id === 'basic') world.shopPaid = world.shopPayments.basic;
  } else if (command.zone === 'open') {
    if (!material.length || material.some((item) => item.type !== 'pack')) throw new Error('Hier kannst du Pakete öffnen.');
    removeCards(world, material.map((item) => item.id));
    let index = 0;
    for (const pack of material) {
      for (let count = 0; count < packRemaining(pack); count++, index++) {
        drawPackCard(world, pack, origin.x + (index % 4) * 155, origin.y + Math.floor(index / 4) * 190, rng, now);
      }
    }
  } else if (command.zone === 'sell') {
    if (material.some((item) => !getCardDefinition(world, item.type)?.sellPrice || (item.type === 'piggyBank' && item.gold > 0))) {
      throw new Error('Dieser Stapel enthält unverkäufliche Karten. Ein gefülltes Sparschwein muss zuerst geleert werden.');
    }
    const gold = material.reduce((total, item) => total + getCardDefinition(world, item.type).sellPrice, 0);
    removeCards(world, moving.map((item) => item.id));
    const coins = scatter(world, 'gold', gold, origin.x + 150, origin.y);
    if (coins.length) coins.forEach((coin, order) => {
      coin.stackId = coins[0].id;
      coin.order = order;
      coin.x = coins[0].x;
      coin.y = coins[0].y;
    });
  } else if (target?.type === 'piggyBank' && material.length && material.every((item) => item.type === 'gold')) {
    target.gold += material.length;
    removeCards(world, material.map((item) => item.id));
  } else if (target && alive(target) && material.length && material.every((item) => effectOf(world, item.type, 'heal')) && target.hp < CONFIG.humanHp) {
    if (material.some((item) => item.type === 'piggyBank' && item.gold > 0)) throw new Error('Leere das Sparschwein zuerst, damit sein Gold erhalten bleibt.');
    const eaten = [];
    for (const food of [...material].sort((a, b) => a.order - b.order)) {
      if (target.hp >= CONFIG.humanHp) break;
      target.hp = Math.min(CONFIG.humanHp, target.hp + effectOf(world, food.type, 'heal').amount);
      eaten.push(food.id);
    }
    removeCards(world, eaten);
  } else if (target && alive(target) && material.length === 1 && getCardDefinition(world, material[0].type)?.category === 'tool') {
    const tool = material[0];
    if (target.toolId && target.toolId !== tool.id) throw new Error('Dieser Mensch trägt bereits ein Werkzeug. Lege es zuerst ab.');
    const previous = findCard(world, tool.equippedTo);
    if (previous) delete previous.toolId;
    tool.equippedTo = target.id;
    target.toolId = tool.id;
    tool.stackId = target.stackId;
    tool.x = target.x;
    tool.y = target.y;
    tool.order = target.order;
  } else {
    // A dragged tool is detached; a human carries their equipped tool along.
    if (card.equippedTo) {
      const previous = findCard(world, card.equippedTo);
      if (previous) delete previous.toolId;
      delete card.equippedTo;
    }
    const targetCards = target ? stackCards(world, target.stackId) : [];
    const offset = normalCards(targetCards).length;
    const stackId = target?.stackId || (command.takeAbove || command.split || wasEquipped ? id(world, 's') : card.stackId);
    const destination = target ? { x: target.x, y: target.y } : point;
    let order = offset;
    for (const item of moving) {
      item.stackId = stackId;
      Object.assign(item, destination);
      if (!item.equippedTo) item.order = order++;
    }
  }
  tidyStacks(world);
  reconcile(world, now);
  return message;
}

/** Apply one already-authorized command. A rejected command leaves world intact. */
export function applyCommand(world, command, { playerId, now = Date.now(), rng = Math.random } = {}) {
  if (!world.players.some((player) => player.id === playerId)) throw new Error('Bitte tritt der Welt zuerst mit deinem Namen bei.');
  if (!command || typeof command !== 'object') throw new Error('Ungültige Aktion.');
  if (command.takeAbove !== undefined && typeof command.takeAbove !== 'boolean') throw new Error('Ungültige Stapelauswahl.');
  const draft = clone(world);
  let message;
  switch (command.type) {
    case 'catalog-save':
      applyCatalogCommand(draft, command);
      // Metadata and effect edits apply to existing cards; unused material is
      // never consumed by a canceled or changed combination.
      for (const human of draft.cards.filter((card) => alive(card) && card.toolId)) {
        if (getCardDefinition(draft, findCard(draft, human.toolId)?.type)?.category !== 'tool') detachTool(draft, human);
      }
      for (const card of draft.cards) {
        const creature = creatureProfile(draft, card);
        if (creature) card.hp = Math.min(card.hp ?? creature.hp, creature.hp);
        if (!creature && card.type !== 'human' && card.type !== 'corpse') delete card.motion;
      }
      reconcile(draft, now);
      message = 'Karten, Kombinationen und Pakete wurden gespeichert.';
      break;
    case 'move':
      if (command.zone && !['shop', 'open', 'sell'].includes(command.zone)) throw new Error('Unbekannte Ablagefläche.');
      message = moveCards(draft, command, now, rng);
      break;
    case 'open-pack': {
      const pack = requireCard(draft, command.cardId);
      if (pack.type !== 'pack') throw new Error('Diese Karte ist kein Paket.');
      const remaining = packRemaining(pack);
      if (remaining <= 0) throw new Error('Dieses Paket ist bereits leer.');
      const popped = drawPackCard(draft, pack, pack.x + 155, pack.y, rng, now);
      pack.cardsLeft = remaining - 1;
      if (pack.cardsLeft === 0) removeCards(draft, [pack.id]);
      message = `${getCardDefinition(draft, popped.type).name} entdeckt.${remaining > 1 ? ` Noch ${remaining - 1} ${remaining === 2 ? 'Karte' : 'Karten'} im Paket.` : ' Das Paket ist leer.'}`;
      reconcile(draft, now);
      break;
    }
    case 'withdraw': {
      const pig = requireCard(draft, command.cardId);
      if (pig.type !== 'piggyBank') throw new Error('Nur ein Sparschwein kann Gold auszahlen.');
      if (pig.gold > 0) {
        pig.gold--;
        addOutput(draft, 'gold', pig, pig.x + 155, pig.y + 30);
      }
      reconcile(draft, now);
      break;
    }
    case 'harvest': {
      const field = requireCard(draft, command.cardId);
      if (field.type !== 'field' || now < field.readyAt) throw new Error('Dieses Feld ist noch nicht erntereif.');
      const point = position(command.x ?? field.x + 155, command.y ?? field.y);
      const berries = scatter(draft, 'berry', CONFIG.fieldHarvestCount, point.x, point.y);
      berries.forEach((berry, order) => Object.assign(berry, { stackId: berries[0].id, x: point.x, y: point.y, order }));
      field.readyAt = now + CONFIG.fieldHarvestInterval;
      reconcile(draft, now);
      break;
    }
    case 'unequip': {
      const human = requireCard(draft, command.cardId);
      if (!alive(human)) throw new Error('Nur lebende Menschen können Werkzeuge ablegen.');
      detachTool(draft, human);
      reconcile(draft, now);
      break;
    }
    default:
      throw new Error('Unbekannte Spielaktion.');
  }
  Object.assign(world, draft);
  return { changed: true, ...(message ? { message } : {}) };
}

function desiredJobs(world, now) {
  const desired = [];
  const engaged = new Set(world.combats.flatMap(combatHumanIds));
  const engagedEnemies = new Set(world.combats.flatMap(combatEnemyIds));
  const stacks = new Map();
  for (const card of normalCards(world.cards)) {
    if (!stacks.has(card.stackId)) stacks.set(card.stackId, []);
    stacks.get(card.stackId).push(card);
  }
  for (const cards of stacks.values()) {
    if (cards.some((card) => engagedEnemies.has(card.id))) continue;
    const humans = cards.filter((card) => alive(card));
    const available = humans.filter((card) => !engaged.has(card.id));
    const human = available.find((card) => world.jobs.some((job) => job.humanId === card.id)) || available[0];
    const materials = cards.filter((card) => card.type !== 'human');
    const sources = materials.filter((card) => effectOf(world, card.type, 'source'));
    const counts = Object.create(null);
    for (const card of materials) counts[card.type] = (counts[card.type] || 0) + 1;
    const recipe = !materials.some((card) => card.type === 'piggyBank' && card.gold > 0) && getRecipes(world).find((entry) => (!entry.requiresHuman || human)
      && Object.keys(entry.ingredients).length === Object.keys(counts).length
      && Object.entries(entry.ingredients).every(([type, count]) => counts[type] === count));
    if (recipe) {
      const worker = recipe.requiresHuman ? human : null;
      desired.push({ kind: recipe.result === 'field' && !recipe.requiresHuman ? 'grow' : 'craft', ...(worker ? { humanId: worker.id } : {}), recipeId: recipe.id,
        cardIds: [...(worker ? [worker.id] : []), ...materials.map((card) => card.id)], duration: recipe.duration, timeBase: recipe.timeBase });
    } else if (human && sources.length && sources.length === materials.length) {
      // A newly added source must not replace the one already being worked.
      const current = world.jobs.find((job) => job.kind === 'source' && job.humanId === human.id
        && sources.some((source) => source.id === job.sourceId));
      const source = sources.find((card) => card.id === current?.sourceId)
        || [...sources].sort((a, b) => a.order - b.order)[0];
      const tool = findCard(world, human.toolId);
      const sourceEffect = effectOf(world, source.type, 'source');
      const toolEffect = tool && effectOf(world, tool.type, 'tool');
      source.remaining ??= sourceEffect.uses;
      const multiplier = toolEffect?.sourceTypes.includes(source.type) ? toolEffect.multiplier : 1;
      desired.push({ kind: 'source', humanId: human.id, sourceId: source.id, cardIds: [human.id, source.id], duration: Math.max(1, sourceEffect.duration * multiplier), timeBase: 'world' });
    }
  }
  return desired.map((job) => ({ ...job, startedAt: job.timeBase === 'real' ? now : world.clock.elapsed }));
}

function reconcileJobs(world, now) {
  const oldJobs = world.jobs;
  world.jobs = desiredJobs(world, now).map((desired) => {
    const existing = oldJobs.find((job) => job.kind === desired.kind && job.timeBase === desired.timeBase
      && (job.recipeId === desired.recipeId || (job.kind === 'grow' && !job.recipeId && desired.recipeId === 'strawberryField'))
      && sameIds(job.cardIds, desired.cardIds));
    if (!existing) return { id: id(world, 'j'), ...desired, dueAt: desired.startedAt + desired.duration };
    if (desired.recipeId) existing.recipeId = desired.recipeId;
    if (existing.duration !== desired.duration) {
      const current = desired.timeBase === 'real' ? now : world.clock.elapsed;
      const progress = clamp((current - existing.startedAt) / existing.duration, 0, 1);
      existing.startedAt = current - progress * desired.duration;
      existing.duration = desired.duration;
      existing.dueAt = existing.startedAt + existing.duration;
    }
    return existing;
  });
}

function ratPosition(rat, elapsed) {
  if (!rat.motion) return { x: rat.x, y: rat.y };
  const fraction = clamp((elapsed - rat.motion.startedAt) / rat.motion.duration, 0, 1);
  return {
    x: rat.motion.fromX + (rat.motion.toX - rat.motion.fromX) * fraction,
    y: rat.motion.fromY + (rat.motion.toY - rat.motion.fromY) * fraction,
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function startCombat(world, rat, humans) {
  delete rat.motion;
  const combat = { id: id(world, 'b'), ratId: rat.id, ratIds: [rat.id], humanId: humans[0].id, humanIds: humans.map((human) => human.id), hits: 0, nextAttackAt: world.clock.elapsed + creatureProfile(world, rat).attackInterval };
  world.combats.push(combat);
  return combat;
}

function reconcileRats(world) {
  const elapsed = world.clock.elapsed;
  const busyHumans = new Set();
  const busyEnemies = new Set();
  world.combats = world.combats.filter((combat) => {
    let enemies = combatEnemyIds(combat).map((enemyId) => findCard(world, enemyId)).filter((enemy) => enemy && isCreature(world, enemy) && enemy.hp > 0 && !busyEnemies.has(enemy.id));
    const humans = combatHumanIds(combat).map((humanId) => findCard(world, humanId)).filter((human) => alive(human) && !busyHumans.has(human.id) && enemies.some((enemy) => distance(enemy, human) <= CONFIG.combatRange + 1));
    if (!humans.length) return false;
    enemies = enemies.filter((enemy) => humans.some((human) => distance(enemy, human) <= CONFIG.combatRange + 1));
    if (!enemies.length) return false;
    combat.ratIds = enemies.map((enemy) => enemy.id);
    if (!combat.ratIds.includes(combat.ratId)) combat.ratId = combat.ratIds[0];
    combat.humanIds = humans.map((human) => human.id);
    if (!combat.humanIds.includes(combat.humanId)) combat.humanId = combat.humanIds[0];
    humans.forEach((human) => busyHumans.add(human.id));
    enemies.forEach((enemy) => busyEnemies.add(enemy.id));
    return true;
  });
  // Rat encounters merge when their front lines meet. Keep the earliest attack
  // boundary so reinforcements cannot postpone a battle by repeatedly joining.
  for (let i = 0; i < world.combats.length; i++) {
    const team = world.combats[i];
    if (findCard(world, team.ratId)?.type !== 'rat') continue;
    for (let j = i + 1; j < world.combats.length; j++) {
      const other = world.combats[j];
      if (findCard(world, other.ratId)?.type !== 'rat') continue;
      const touches = (a, b) => combatEnemyIds(a).some((enemyId) => combatHumanIds(b).some((humanId) => distance(findCard(world, enemyId), findCard(world, humanId)) <= CONFIG.combatRange + .01));
      if (!touches(team, other) && !touches(other, team)) continue;
      team.ratIds = [...new Set([...combatEnemyIds(team), ...combatEnemyIds(other)])];
      team.humanIds = [...new Set([...combatHumanIds(team), ...combatHumanIds(other)])];
      team.nextAttackAt = Math.min(team.nextAttackAt, other.nextAttackAt);
      team.hits += other.hits || 0;
      world.combats.splice(j, 1); j = i;
    }
  }
  for (const rat of world.cards.filter((card) => isCreature(world, card))) {
    const profile = creatureProfile(world, rat);
    rat.hp ??= profile.hp;
    const ongoing = world.combats.find((combat) => combatEnemyIds(combat).includes(rat.id));
    if (ongoing) {
      for (const human of world.cards.filter((card) => alive(card) && !busyHumans.has(card.id) && distance(rat, card) <= CONFIG.combatRange + .01)) {
        ongoing.humanIds.push(human.id); busyHumans.add(human.id);
      }
      continue;
    }
    const point = ratPosition(rat, elapsed);
    const ratTeam = rat.type === 'rat' && world.combats.find((combat) => findCard(world, combat.ratId)?.type === 'rat' && combatHumanIds(combat).some((humanId) => {
      const fighter = findCard(world, humanId);
      return distance(point, fighter) <= CONFIG.combatRange + .01 && (profile.aggressive || fighter.stackId === rat.stackId);
    }));
    if (ratTeam) {
      Object.assign(rat, point); delete rat.motion;
      ratTeam.ratIds.push(rat.id); busyEnemies.add(rat.id);
      for (const helper of world.cards.filter((card) => alive(card) && !busyHumans.has(card.id) && distance(point, card) <= CONFIG.combatRange + .01)) {
        ratTeam.humanIds.push(helper.id); busyHumans.add(helper.id);
      }
      continue;
    }
    const human = world.cards.filter((card) => alive(card) && (rat.type === 'rat' || !busyHumans.has(card.id)))
      .sort((a, b) => distance(a, point) - distance(b, point) || a.id.localeCompare(b.id))[0];
    const fighters = world.cards.filter((card) => alive(card) && !busyHumans.has(card.id) && distance(point, card) <= CONFIG.combatRange + .01)
      .sort((a, b) => distance(a, point) - distance(b, point) || a.id.localeCompare(b.id));
    if (fighters.some((fighter) => profile.aggressive || fighter.stackId === rat.stackId)) {
      Object.assign(rat, point);
      startCombat(world, rat, fighters);
      fighters.forEach((fighter) => busyHumans.add(fighter.id));
      continue;
    }
    // Stacking a peaceful animal keeps it with its stack instead of dragging
    // other cards around. Hostile cards still attack a stacked human above.
    if (profile.behavior === 'stationary' || normalCards(stackCards(world, rat.stackId)).length > 1) {
      Object.assign(rat, point); delete rat.motion; continue;
    }
    if (profile.behavior === 'wander') {
      if (rat.motion?.behavior === 'wander') continue;
      let seed = 2166136261;
      for (const char of `${rat.id}:${Math.floor(elapsed)}`) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
      const angle = seed / 4294967296 * Math.PI * 2;
      const destination = position(point.x + Math.cos(angle) * 130, Math.max(112, point.y + Math.sin(angle) * 130));
      Object.assign(rat, point);
      rat.motion = { behavior: 'wander', fromX: point.x, fromY: point.y, toX: destination.x, toY: destination.y, startedAt: elapsed, duration: Math.max(2000, distance(point, destination) / profile.speed * 1000) };
      continue;
    }
    const target = profile.target === 'human' ? human : world.cards.filter((card) => card.id !== rat.id && card.type === profile.target).sort((a, b) => distance(a, point) - distance(b, point) || a.id.localeCompare(b.id))[0];
    if (!target) { Object.assign(rat, point); delete rat.motion; continue; }
    const gap = distance(point, target);
    const range = alive(target) && profile.aggressive ? CONFIG.combatRange : 65;
    if (gap <= range + .01) { Object.assign(rat, point); delete rat.motion; continue; }
    if (rat.motion?.targetId === target.id && rat.motion.targetX === target.x && rat.motion.targetY === target.y) continue;
    const travel = gap - range;
    const fraction = travel / gap;
    Object.assign(rat, point);
    rat.motion = {
      fromX: point.x, fromY: point.y,
      toX: point.x + (target.x - point.x) * fraction,
      toY: point.y + (target.y - point.y) * fraction,
      targetId: target.id, targetX: target.x, targetY: target.y,
      startedAt: elapsed, duration: Math.max(1, travel / profile.speed * 1000),
    };
  }
}

function reconcile(world, now) {
  tidyStacks(world);
  reconcileRats(world);
  reconcileJobs(world, now);
}

function completeJob(world, job, now, rng) {
  world.jobs = world.jobs.filter((current) => current.id !== job.id);
  const anchor = findCard(world, job.sourceId || job.humanId || job.cardIds[0]);
  if (!anchor || job.cardIds.some((cardId) => !findCard(world, cardId))) return;
  if (job.kind === 'source') {
    const sourceEffect = effectOf(world, anchor.type, 'source');
    if (!sourceEffect) return;
    const result = weightedChoice(sourceEffect.outputs, rng);
    // Consecutive outputs form their own stack next to the work area.
    const human = findCard(world, job.humanId);
    for (let index = 0; index < result.count; index++) addOutput(world, result.type, anchor, human.x + 155, human.y + 15, {
      sourceOutputId: anchor.id, ...(result.type === 'field' ? { readyAt: now + CONFIG.fieldHarvestInterval } : {}),
    });
    anchor.remaining--;
    if (anchor.remaining <= 0) {
      removeCards(world, [anchor.id]);
    } else {
      // Keep the same source through its remaining cycles, even when a newly
      // stacked source now has a lower order. Only one cycle runs at a time.
      world.jobs.push({ ...job, startedAt: world.clock.elapsed, dueAt: world.clock.elapsed + job.duration });
    }
  } else if (job.kind === 'craft' || job.kind === 'grow') {
    const recipe = getRecipes(world).find((entry) => entry.id === (job.recipeId || 'strawberryField'));
    if (!recipe) return;
    if (job.cardIds.some((cardId) => {
      const card = findCard(world, cardId);
      return card.type === 'piggyBank' && card.gold > 0;
    })) return;
    const human = findCard(world, job.humanId);
    const point = human ? { x: human.x + 155, y: human.y + 15 } : { x: anchor.x, y: anchor.y };
    removeCards(world, job.cardIds.filter((cardId) => cardId !== human?.id && !recipe.keepIngredients?.includes(findCard(world, cardId)?.type)));
    const extra = recipe.result === 'field' ? { readyAt: (job.timeBase === 'real' ? job.dueAt : now) + CONFIG.fieldHarvestInterval } : {};
    for (let index = 0; index < recipe.resultCount; index++) addCard(world, recipe.result, point.x + index * 145, point.y, extra);
  }
}

function attack(world, combat, rng) {
  const enemies = combatEnemyIds(combat).map((enemyId) => findCard(world, enemyId)).filter((enemy) => enemy?.hp > 0);
  const humans = combatHumanIds(combat).map((humanId) => findCard(world, humanId)).filter(alive);
  if (!enemies.length || !humans.length) return;
  const profile = creatureProfile(world, enemies[0]);
  const hits = [];
  for (const human of humans) {
    const enemy = enemies.find((target) => target.hp > 0 && distance(human, target) <= CONFIG.combatRange + 1);
    if (enemy) { const damage = Math.min(enemy.hp, humanDamage(world, human)); enemy.hp -= damage; hits.push({ humanId: human.id, enemyId: enemy.id, damage, x: enemy.x, y: enemy.y, order: enemy.order || 0 }); }
  }
  const damage = [];
  // Both teams strike simultaneously. Even a defeated rat retaliates this
  // round, matching the established solo-combat rule.
  for (const enemy of enemies) {
    const target = humans.find((human) => human.id === combat.humanId && alive(human) && distance(enemy, human) <= CONFIG.combatRange + 1)
      || humans.find((human) => alive(human) && distance(enemy, human) <= CONFIG.combatRange + 1);
    if (!target) continue;
    const amount = creatureProfile(world, enemy).damage;
    target.hp = Math.max(0, target.hp - amount);
    damage.push({ humanId: target.id, enemyId: enemy.id, amount });
  }
  combat.hits += hits.length;
  combat.lastHits = hits;
  combat.lastDamage = damage;
  combat.lastTargetId = damage[0]?.humanId;
  combat.lastHitCount = hits.length;
  combat.lastHitDamage = hits.reduce((sum, hit) => sum + hit.damage, 0);
  combat.lastAttackAt = world.clock.elapsed;
  combat.nextAttackAt += profile.attackInterval;
  for (const human of humans.filter((fighter) => fighter.hp === 0)) {
    detachTool(world, human);
    human.type = 'corpse';
    human.diedAt = world.clock.elapsed;
  }
  for (const rat of enemies.filter((enemy) => enemy.hp <= 0)) {
    const roll = rng();
    const drops = deathDropsFor(world, rat);
    if (roll < drops.chance / 100 && drops.outputs.length) {
      const total = drops.outputs.reduce((sum, output) => sum + output.weight, 0);
      let cumulative = 0;
      const output = drops.outputs.find((entry) => {
        cumulative += entry.weight;
        return roll < cumulative * drops.chance / (total * 100);
      }) || drops.outputs.at(-1);
      for (let count = 0; count < output.count; count++) addOutput(world, output.type, rat, rat.x + 155, rat.y + 30);
    }
    removeCards(world, [rat.id]);
  }
  combat.humanIds = humans.filter(alive).map((fighter) => fighter.id);
  combat.ratIds = enemies.filter((enemy) => enemy.hp > 0).map((enemy) => enemy.id);
  combat.ratId = combat.ratIds[0];
  if (!combat.humanIds.includes(combat.humanId)) combat.humanId = combat.humanIds[0];
  if (!combat.ratIds.length || !combat.humanIds.length) world.combats = world.combats.filter((item) => item.id !== combat.id);
}

function nextWorldEvent(world) {
  const times = [
    ...world.jobs.filter((job) => job.timeBase === 'world').map((job) => job.dueAt),
    ...world.combats.map((combat) => combat.nextAttackAt),
    ...world.cards.filter((card) => card.motion).map((card) => card.motion.startedAt + card.motion.duration),
  ];
  // A wandering attacker meets a human at the actual intersection of its
  // path and the combat radius, rather than waiting for the end of its walk.
  for (const creature of world.cards) {
    const motion = creature.motion;
    if (motion?.behavior !== 'wander' || !creatureProfile(world, creature)?.aggressive) continue;
    const dx = motion.toX - motion.fromX, dy = motion.toY - motion.fromY;
    const a = dx * dx + dy * dy;
    if (!a) continue;
    for (const human of world.cards.filter((card) => alive(card) && (creature.type === 'rat' || !world.combats.some((combat) => combatHumanIds(combat).includes(card.id))))) {
      const ox = motion.fromX - human.x, oy = motion.fromY - human.y;
      const b = 2 * (ox * dx + oy * dy);
      const c = ox * ox + oy * oy - CONFIG.combatRange ** 2;
      const discriminant = b * b - 4 * a * c;
      if (discriminant < 0) continue;
      const entry = (-b - Math.sqrt(discriminant)) / (2 * a);
      const at = motion.startedAt + entry * motion.duration;
      if (entry >= 0 && entry <= 1 && at > world.clock.elapsed + .001) times.push(at);
    }
  }
  return times.length ? Math.min(...times) : null;
}

/**
 * Advance active-world events only through activeUntil. Real-time growth always
 * advances to now. Presence is managed by the backend, not by this pure engine.
 * A single call may process all five source yields without per-second ticking.
 */
export function advanceWorld(world, now = Date.now(), { activeUntil = now, rng = Math.random } = {}) {
  const before = JSON.stringify({ cards: world.cards, jobs: world.jobs, combats: world.combats });
  const startElapsed = world.clock.elapsed;
  const lastAt = world.clock.lastAt;
  const endElapsed = startElapsed + Math.max(0, Math.min(now, activeUntil) - lastAt);
  let next;
  let safety = 0;
  while ((next = nextWorldEvent(world)) !== null && next <= endElapsed) {
    if (++safety > 100_000) throw new Error('Zu viele gleichzeitige Weltaktionen.');
    world.clock.elapsed = Math.max(world.clock.elapsed, next);
    for (const rat of world.cards.filter((card) => card.motion && card.motion.startedAt + card.motion.duration <= world.clock.elapsed + 0.001)) {
      Object.assign(rat, { x: rat.motion.toX, y: rat.motion.toY });
      delete rat.motion;
    }
    for (const job of [...world.jobs].filter((job) => job.timeBase === 'world' && job.dueAt <= world.clock.elapsed)) {
      completeJob(world, job, now, rng);
    }
    for (const combat of [...world.combats].filter((combat) => combat.nextAttackAt <= world.clock.elapsed)) attack(world, combat, rng);
    reconcile(world, now);
  }
  world.clock.elapsed = endElapsed;
  world.clock.lastAt = Math.max(lastAt, now);
  // Growth is checked once, including after many offline days. No daily loop.
  for (const job of [...world.jobs].filter((job) => job.timeBase === 'real' && job.dueAt <= now)) completeJob(world, job, now, rng);
  reconcile(world, now);
  return before !== JSON.stringify({ cards: world.cards, jobs: world.jobs, combats: world.combats });
}

/** Next actual event boundary. Calling code must stop active timers offline. */
export function nextWakeAt(world, now = Date.now()) {
  const active = nextWorldEvent(world);
  const times = world.jobs.filter((job) => job.timeBase === 'real').map((job) => job.dueAt);
  if (active !== null) times.push(world.clock.lastAt + Math.max(0, active - world.clock.elapsed));
  // Field readiness is a derived real timestamp and requires no mutation/timer.
  return times.length ? Math.max(now, Math.min(...times)) : null;
}

export function publicWorld(world) {
  const result = { ...clone(world), catalog: clone(getCatalog(world)), shopPaid: world.shopPaid ?? world.shopPayments?.basic ?? 0 };
  result.shopPayments = { ...world.shopPayments, basic: result.shopPaid };
  result.cards = result.cards.map((card) => card.type === 'pack' ? { ...card, cardsLeft: packRemaining(card) } : card);
  return result;
}
