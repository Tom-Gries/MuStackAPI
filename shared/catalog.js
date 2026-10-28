import { ART_LIBRARY } from './art-library.js';

/** Central, server-authoritative V1 values. All times are milliseconds. */
export const CONFIG = Object.freeze({
  packPrice: 3,
  packSize: 3,
  startingGold: 9,
  humanHp: 75,
  sourceDuration: 10_000,
  sourceUses: 5,
  fieldGrowDuration: 3_600_000,
  fieldHarvestInterval: 86_400_000,
  fieldHarvestCount: 10,
  attackInterval: 2_000,
  ratHp: 2,
  ratDamage: 1,
  ratSpeed: 35,
  combatRange: 100,
  worldWidth: 1800,
  worldHeight: 1200,
  cardWidth: 128,
  cardHeight: 174,
  stackOffset: 28,
});

const type = (name, category, color, icon, sellPrice, description) =>
  Object.freeze({ name, category, color, icon, sellPrice, description });

const BUILTIN_CARDS = {
  human: type('Mensch', 'human', '#eedbc2', '🧑', 0, '75 Leben. Ziehe einen Menschen auf eine Quelle oder auf passende Zutaten, damit er arbeitet.'),
  gold: type('Gold', 'resource', '#f5ca61', '✦', 0, 'Ein Gold. Drei Gold kaufen ein Basicpaket.'),
  pack: type('Basicpaket', 'pack', '#b4ceaa', '▣', 2, 'Drei zufällige Karten. Mit jedem Klick springt eine Karte heraus; nach der dritten ist das Paket leer.'),
  tree: type('Baum', 'source', '#a3b78b', '🌳', 1, 'Mensch darauflegen: fünfmal Holz (70 %) oder Stock (30 %). Mit einer Axt doppelt so schnell.'),
  rock: type('Fels', 'source', '#b9b7af', '🪨', 1, 'Mensch darauflegen: fünfmal Stein (80 %) oder Feuerstein (20 %). Mit Spitzhacke doppelt so schnell.'),
  berryBush: type('Beerenbusch', 'source', '#b9b38b', '🫐', 1, 'Mensch darauflegen: fünf Durchläufe ergeben je eine Beere.'),
  wood: type('Holz', 'resource', '#c79973', '🪵', 1, 'Baumaterial für Werkzeuge, Lager und Sparschwein.'),
  stick: type('Stock', 'resource', '#d8bc92', '╱', 1, 'Ein kleiner Ast. Kann für ein Gold verkauft werden.'),
  stone: type('Stein', 'resource', '#c0c0b8', '◆', 1, 'Baumaterial für Werkzeuge und Lager.'),
  flint: type('Feuerstein', 'resource', '#92988d', '◈', 1, 'Kann für ein Gold verkauft werden.'),
  berry: type('Beere', 'food', '#e3a49c', '🍓', 1, 'Auf einen lebenden Menschen ziehen: heilt ein Leben. Mit fruchtbarem Boden entsteht ein Erdbeerfeld.'),
  rat: type('Ratte', 'enemy', '#d5a39b', '🐀', 0, 'Verfolgt Menschen. Zwei Treffer besiegen sie; jeder ihrer Angriffe verursacht ein Schaden.'),
  soil: type('Fruchtbarer Boden', 'source', '#b6a07b', '🌱', 2, 'Mit einer Beere wird daraus nach einer Stunde Echtzeit ein Erdbeerfeld.'),
  field: type('Erdbeerfeld', 'building', '#9eb38b', '🍓', 3, 'Alle 24 Stunden zehn Beeren, auch offline. Es wird höchstens eine Ernte gespeichert.'),
  piggyBank: type('Sparschwein', 'building', '#e3b3ac', '🐷', 3, 'Gold hineinziehen. Ein Klick nimmt ein Gold heraus. Zum Paketkauf ein ausreichend gefülltes Sparschwein auf das gewünschte Paket im Laden ziehen. Zum Verkaufen zuerst leeren.'),
  warehouse: type('Lager', 'building', '#c5b090', '🏠', 5, 'Bereit für ein späteres Kartenlimit. In dieser Version hat das Lager noch keine Zusatzwirkung.'),
  axe: type('Axt', 'tool', '#aec3ba', '🪓', 3, 'Auf einen Menschen ziehen: halbiert die Abbauzeit am Baum. Ein Werkzeugplatz pro Mensch.'),
  pickaxe: type('Spitzhacke', 'tool', '#b4bfc4', '⛏️', 3, 'Auf einen Menschen ziehen: halbiert die Abbauzeit am Fels. Ein Werkzeugplatz pro Mensch.'),
  bone: type('Knochen', 'resource', '#e4dfcc', '🦴', 1, 'Rattenbeute. Kann für ein Gold verkauft werden.'),
  meat: type('Fleisch', 'resource', '#d9988c', '🥩', 1, 'Rattenbeute. Kann für ein Gold verkauft werden.'),
  corpse: type('Leiche', 'human', '#aaa69e', '☠', 0, 'Dieser Mensch ist gestorben. Ein Totem zur Wiederbelebung folgt in einer späteren Version.'),
  campfire: type('Feuer', 'building', '#e4bf8f', '🔥', 2, 'Brät Fleisch. Das Feuer bleibt beim Braten erhalten.'),
  knife: type('Messer', 'tool', '#bec8bc', '🔪', 2, 'Auf einen Menschen ziehen: erhöht seinen Kampfschaden um 1. Ein Werkzeugplatz pro Mensch.'),
  cow: type('Kuh', 'creature', '#d5c5a9', '🐄', 3, 'Ein friedliches Lebewesen. Verhalten und Angriffslust lassen sich im Editor einstellen.'),
  rabbit: type('Hase', 'creature', '#cfbaa2', '🐇', 2, 'Ein friedlicher Hase, der über den Tisch läuft.'),
  chicken: type('Huhn', 'creature', '#e8d9b3', '🐔', 2, 'Mensch darauflegen: beginnt einen Kampf. Beim Tod fällt ein Knochen, Ei oder Fleisch heraus.'),
  egg: type('Ei', 'food', '#ece3cb', '🥚', 1, 'Ein Ei für neue Kombinationen. Weitere Wirkungen können später ergänzt werden.'),
  barn: type('Stall', 'building', '#c7ad84', '🏚️', 4, 'Ein Stall für eure Lichtung. Weitere Wirkungen können später ergänzt werden.'),
  cookedMeat: type('Gebratenes Fleisch', 'food', '#d9ad7f', '🥩', 3, 'Fleisch über einem Feuer gebraten.'),
};

const DEFAULT_EFFECTS = {
  tree: [{ kind: 'source', duration: CONFIG.sourceDuration, uses: CONFIG.sourceUses, outputs: [{ type: 'wood', count: 1, weight: 70 }, { type: 'stick', count: 1, weight: 30 }] }],
  rock: [{ kind: 'source', duration: CONFIG.sourceDuration, uses: CONFIG.sourceUses, outputs: [{ type: 'stone', count: 1, weight: 80 }, { type: 'flint', count: 1, weight: 20 }] }],
  berryBush: [{ kind: 'source', duration: CONFIG.sourceDuration, uses: CONFIG.sourceUses, outputs: [{ type: 'berry', count: 1, weight: 1 }] }],
  berry: [{ kind: 'heal', amount: 1 }],
  axe: [{ kind: 'tool', sourceTypes: ['tree'], multiplier: 0.5 }],
  pickaxe: [{ kind: 'tool', sourceTypes: ['rock'], multiplier: 0.5 }],
  knife: [{ kind: 'weapon', damage: 1 }],
};

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

export const DEFAULT_CREATURE = Object.freeze({ aggressive: false, behavior: 'stationary', target: 'human', speed: 20, hp: 2, damage: 1, attackInterval: 2000 });
const CREATURE_DEFAULTS = {
  cow: { ...DEFAULT_CREATURE, behavior: 'wander', hp: 4, speed: 15 },
  rabbit: { ...DEFAULT_CREATURE, behavior: 'wander', speed: 28 },
  chicken: { ...DEFAULT_CREATURE, behavior: 'wander', speed: 18 },
};
export const DEFAULT_RAT_DROPS = freezeDeep({ chance: 90, outputs: [{ type: 'gold', count: 1, weight: 40 }, { type: 'bone', count: 1, weight: 30 }, { type: 'meat', count: 1, weight: 20 }] });
export const DEFAULT_CHICKEN_DROPS = freezeDeep({ chance: 100, outputs: [{ type: 'bone', count: 1, weight: 1 }, { type: 'egg', count: 1, weight: 1 }, { type: 'meat', count: 1, weight: 1 }] });
export const CARD_TYPES = freezeDeep(Object.fromEntries(Object.entries(BUILTIN_CARDS)
  .map(([id, definition]) => [id, { ...definition, art: id, effects: DEFAULT_EFFECTS[id] || [], ...(CREATURE_DEFAULTS[id] ? { creature: CREATURE_DEFAULTS[id] } : {}), ...(id === 'rat' ? { deathDrops: DEFAULT_RAT_DROPS } : id === 'chicken' ? { deathDrops: DEFAULT_CHICKEN_DROPS } : {}) }])));

export const RECIPES = Object.freeze([
  Object.freeze({ id: 'piggyBank', name: 'Sparschwein', ingredients: { gold: 5, wood: 2 }, duration: 60_000, result: 'piggyBank', resultCount: 1, requiresHuman: true, timeBase: 'world' }),
  Object.freeze({ id: 'warehouse', name: 'Lager', ingredients: { wood: 5, stone: 5 }, duration: 30_000, result: 'warehouse', resultCount: 1, requiresHuman: true, timeBase: 'world' }),
  Object.freeze({ id: 'axe', name: 'Axt', ingredients: { wood: 5, stone: 1 }, duration: 20_000, result: 'axe', resultCount: 1, requiresHuman: true, timeBase: 'world' }),
  Object.freeze({ id: 'pickaxe', name: 'Spitzhacke', ingredients: { wood: 5, stone: 2 }, duration: 20_000, result: 'pickaxe', resultCount: 1, requiresHuman: true, timeBase: 'world' }),
  Object.freeze({ id: 'strawberryField', name: 'Erdbeerfeld', ingredients: { soil: 1, berry: 1 }, duration: CONFIG.fieldGrowDuration, result: 'field', resultCount: 1, requiresHuman: false, timeBase: 'real' }),
  Object.freeze({ id: 'huhn', name: 'Huhn', ingredients: { chicken: 1, egg: 1 }, duration: 10_000, result: 'chicken', resultCount: 1, requiresHuman: false, timeBase: 'world' }),
  Object.freeze({ id: 'ei', name: 'EI', ingredients: { chicken: 1 }, duration: 10_000, result: 'egg', resultCount: 1, requiresHuman: false, timeBase: 'world' }),
  Object.freeze({ id: 'knife', name: 'Messer', ingredients: { stick: 1, flint: 1 }, duration: 10_000, result: 'knife', resultCount: 1, requiresHuman: true, timeBase: 'world' }),
  Object.freeze({ id: 'campfire', name: 'Feuer', ingredients: { stick: 3, flint: 1 }, duration: 10_000, result: 'campfire', resultCount: 1, requiresHuman: false, timeBase: 'world' }),
  Object.freeze({ id: 'cookMeat', name: 'Fleisch braten', ingredients: { campfire: 1, meat: 1 }, keepIngredients: ['campfire'], duration: 10_000, result: 'cookedMeat', resultCount: 1, requiresHuman: false, timeBase: 'world' }),
]);

export const PACK_CHANCES = Object.freeze([
  { type: 'tree', chance: 0.33 },
  { type: 'rock', chance: 0.33 },
  { type: 'berryBush', chance: 0.32 },
  { type: 'rat', chance: 0.01 },
  { type: 'soil', chance: 0.01 },
]);

export const PACKS = freezeDeep([{
  id: 'basic', name: 'Basicpaket', description: 'Drei zufällige Karten für euren Anfang: Quellen und seltene Entdeckungen.',
  color: '#b4ceaa', price: CONFIG.packPrice, size: CONFIG.packSize,
  contents: PACK_CHANCES.map(({ type, chance }) => ({ type, weight: Math.round(chance * 100) })),
}, {
  id: 'farm', name: 'Farm', description: '', color: '#5bc867', price: 10, size: 3,
  contents: [{ type: 'cow', weight: 10 }, { type: 'rat', weight: 30 }, { type: 'chicken', weight: 30 }, { type: 'rabbit', weight: 30 }],
}]);

export const PROTECTED_CARD_TYPES = Object.freeze(['human', 'gold', 'pack', 'rat', 'soil', 'field', 'piggyBank', 'corpse']);
export const CARD_CATEGORIES = Object.freeze(['resource', 'food', 'source', 'building', 'tool', 'creature']);
export const CATALOG_LIMITS = Object.freeze({ cardTypes: 200, recipes: 200, packs: 40, effects: 8, outputs: 30, duration: 604_800_000, size: 30, price: 1000 });
export const DEFAULT_CATALOG = freezeDeep({ revision: 0, contentVersion: 3, cardTypes: CARD_TYPES, recipes: RECIPES, packs: PACKS });

/** Old saves resolve through defaults without producing a database write. */
export function getCatalog(world) {
  const catalog = world?.catalog;
  if (!catalog) return DEFAULT_CATALOG;
  if (catalog.contentVersion >= 3) return catalog;
  const cardTypes = { ...catalog.cardTypes };
  if (!(catalog.contentVersion >= 2)) for (const id of ['campfire', 'knife', 'cow', 'rabbit', 'chicken', 'egg', 'barn']) cardTypes[id] ??= CARD_TYPES[id];
  cardTypes.cookedMeat ??= CARD_TYPES.cookedMeat;
  if (cardTypes.knife && !cardTypes.knife.effects?.some((effect) => effect.kind === 'weapon')) cardTypes.knife = { ...cardTypes.knife, effects: [...(cardTypes.knife.effects || []), ...DEFAULT_EFFECTS.knife] };
  if (cardTypes.chicken && cardTypes.chicken.deathDrops === undefined) cardTypes.chicken = { ...cardTypes.chicken, deathDrops: DEFAULT_CHICKEN_DROPS };
  if (cardTypes.campfire?.name === 'Lagerfeuer') cardTypes.campfire = { ...cardTypes.campfire, name: 'Feuer' };
  const recipes = [...catalog.recipes];
  const signature = (recipe) => JSON.stringify(Object.entries(recipe.ingredients).sort(([a], [b]) => a.localeCompare(b)));
  for (const recipe of RECIPES.filter((entry) => ['knife', 'campfire', 'cookMeat'].includes(entry.id))) {
    if (Object.hasOwn(cardTypes, recipe.result) && Object.keys(recipe.ingredients).every((id) => Object.hasOwn(cardTypes, id)) && !recipes.some((existing) => existing.id === recipe.id || signature(existing) === signature(recipe))) recipes.push(recipe);
  }
  return { ...catalog, contentVersion: 3, cardTypes, recipes };
}
export const getCardTypes = (world) => getCatalog(world).cardTypes;
export const getRecipes = (world) => getCatalog(world).recipes;
export const getPacks = (world) => getCatalog(world).packs;
export const getCardDefinition = (world, cardType) => Object.hasOwn(getCardTypes(world), cardType) ? getCardTypes(world)[cardType] : undefined;

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} muss ein Objekt sein.`);
  return value;
}

function text(value, label, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) invalid(`${label} ist ungültig (höchstens ${max} Zeichen).`);
  return value.trim();
}

function name(value, label) {
  const result = text(value, label, 80);
  if (!result) invalid(`${label} darf nicht leer sein.`);
  return result;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-zA-Z0-9_-]{0,47}$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value)) invalid(`${label}: Verwende eine ID mit Buchstaben, Zahlen, _ oder -; der erste Buchstabe muss klein sein.`);
  return value;
}

function number(value, label, min, max, integer = true) {
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) invalid(`${label} muss ${integer ? 'eine ganze Zahl' : 'eine Zahl'} zwischen ${min} und ${max} sein.`);
  return value;
}

function color(value) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) invalid('Die Kartenfarbe muss eine Hex-Farbe sein, zum Beispiel #a3b78b.');
  return value.toLowerCase();
}

function list(value, label, max, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid(`${label}: Erlaubt sind ${min} bis ${max} Einträge.`);
  return value;
}

function reference(types, value, label) {
  identifier(value, label);
  if (!Object.hasOwn(types, value)) invalid(`${label}: Die Karte „${value}“ ist nicht definiert oder wird noch verwendet.`);
  return value;
}

function generatedReference(types, value, label) {
  reference(types, value, label);
  if (value === 'human') invalid(`${label}: Menschen entstehen ausschließlich beim Beitritt mit einem Namen.`);
  return value;
}

/** Validate the whole draft before replacing any authoritative definitions. */
export function validateCatalog(input, world) {
  object(input, 'Katalog');
  const incoming = object(input.cardTypes, 'Karten');
  const entries = Object.entries(incoming);
  if (!entries.length || entries.length > CATALOG_LIMITS.cardTypes) invalid(`Es sind höchstens ${CATALOG_LIMITS.cardTypes} Kartentypen erlaubt.`);
  const cardTypes = {};
  for (const [id, raw] of entries) {
    identifier(id, 'Karten-ID');
    object(raw, `Karte ${id}`);
    const core = PROTECTED_CARD_TYPES.includes(id);
    const category = raw.category;
    if (core ? category !== CARD_TYPES[id].category : !CARD_CATEGORIES.includes(category)) invalid(`Die Kategorie von „${id}“ ist ungültig oder geschützt.`);
    const art = text(raw.art, 'Illustration', 48, Object.hasOwn(CARD_TYPES, id) ? id : '');
    if (art && !Object.hasOwn(CARD_TYPES, art) && !ART_LIBRARY.some((entry) => entry.id === art)) invalid(`Unbekannte Illustration „${art}“.`);
    const sellPrice = number(raw.sellPrice, 'Verkaufspreis', 0, 1000);
    if (['human', 'gold', 'rat', 'corpse'].includes(id) && sellPrice !== 0) invalid(`„${id}“ bleibt unverkäuflich.`);
    cardTypes[id] = {
      name: name(raw.name, 'Kartenname'), category, color: color(raw.color),
      icon: text(raw.icon, 'Symbol', 20, '✦'), art, sellPrice,
      description: text(raw.description, 'Beschreibung', 2000, ''), effects: [],
    };
    if (category === 'creature' || (id === 'rat' && raw.creature)) {
      const creature = object(raw.creature ?? DEFAULT_CREATURE, 'Lebewesen-Einstellungen');
      if (typeof creature.aggressive !== 'boolean') invalid('„Angreifend“ muss ein Schalter sein.');
      if (!['stationary', 'wander', 'seek'].includes(creature.behavior)) invalid('Wähle Stehend, Rumlaufend oder Zielsuchend.');
      cardTypes[id].creature = {
        aggressive: creature.aggressive, behavior: creature.behavior,
        target: creature.target ?? 'human', speed: number(creature.speed ?? 20, 'Laufgeschwindigkeit', 1, 100),
        hp: number(creature.hp ?? 2, 'Leben des Lebewesens', 1, 1000), damage: number(creature.damage ?? 1, 'Angriffsschaden', 0, 100),
        attackInterval: number(creature.attackInterval ?? 2000, 'Angriffsabstand', 500, 60000),
      };
    }
  }
  for (const id of PROTECTED_CARD_TYPES) if (!Object.hasOwn(cardTypes, id)) invalid(`Die Grundkarte „${CARD_TYPES[id].name}“ kann nicht gelöscht werden.`);
  for (const card of Object.values(cardTypes)) if (card.creature) reference(cardTypes, card.creature.target, 'Ziel des Lebewesens');
  for (const [id, raw] of entries) {
    if (raw.deathDrops !== undefined) {
      if (cardTypes[id].category !== 'creature' && id !== 'rat') invalid('Beute beim Tod gehört auf ein Lebewesen.');
      const drops = object(raw.deathDrops, 'Beute beim Tod');
      const chance = number(drops.chance, 'Beutechance', 0, 100, false);
      cardTypes[id].deathDrops = { chance, outputs: list(drops.outputs, 'Mögliche Beute', CATALOG_LIMITS.outputs, chance > 0 ? 1 : 0).map((entry) => {
        object(entry, 'Beuteeintrag');
        return { type: generatedReference(cardTypes, entry.type, 'Beute beim Tod'), count: number(entry.count ?? 1, 'Beutemenge', 1, 30), weight: number(entry.weight, 'Beutegewicht', 0.0001, 1_000_000, false) };
      }) };
      if (new Set(cardTypes[id].deathDrops.outputs.map((entry) => entry.type)).size !== cardTypes[id].deathDrops.outputs.length) invalid('Eine Karte darf in der Beute nur einmal vorkommen.');
    }
    const kinds = new Set();
    for (const effect of list(raw.effects ?? [], `Effekte von ${id}`, CATALOG_LIMITS.effects)) {
      object(effect, 'Effekt');
      if (kinds.has(effect.kind)) invalid(`„${id}“ hat denselben Effekt mehrfach.`);
      kinds.add(effect.kind);
      if (effect.kind === 'source') {
        if (cardTypes[id].category !== 'source' || PROTECTED_CARD_TYPES.includes(id)) invalid('Ein Abbaueffekt gehört auf eine Quellenkarte ohne feste Spezialfunktion.');
        cardTypes[id].effects.push({ kind: 'source', duration: number(effect.duration, 'Abbaudauer in Millisekunden', 1000, CATALOG_LIMITS.duration), uses: number(effect.uses, 'Abbauvorgänge', 1, 1000),
          outputs: list(effect.outputs, 'Abbauprodukte', CATALOG_LIMITS.outputs, 1).map((entry) => {
            object(entry, 'Abbauprodukt');
            return { type: generatedReference(cardTypes, entry.type, 'Abbauprodukt'), count: number(entry.count ?? 1, 'Produktmenge', 1, 30), weight: number(entry.weight, 'Produktgewicht', 0.0001, 1_000_000, false) };
          }) });
      } else if (effect.kind === 'heal') {
        if (['human', 'corpse'].includes(id)) invalid('Menschen und Leichen können nicht als Heilmittel verbraucht werden.');
        cardTypes[id].effects.push({ kind: 'heal', amount: number(effect.amount, 'Heilung', 1, CONFIG.humanHp) });
      } else if (effect.kind === 'tool') {
        if (cardTypes[id].category !== 'tool') invalid('Ein Werkzeugeffekt gehört auf eine Werkzeugkarte.');
        cardTypes[id].effects.push({ kind: 'tool', sourceTypes: [...new Set(list(effect.sourceTypes, 'Werkzeugquellen', CATALOG_LIMITS.cardTypes, 1).map((type) => reference(cardTypes, type, 'Werkzeugquelle')))], multiplier: number(effect.multiplier, 'Zeitfaktor', 0.05, 10, false) });
      } else if (effect.kind === 'weapon') {
        if (cardTypes[id].category !== 'tool') invalid('Ein Waffeneffekt gehört auf eine Werkzeugkarte.');
        cardTypes[id].effects.push({ kind: 'weapon', damage: number(effect.damage, 'Zusätzlicher Kampfschaden', 1, 100) });
      } else invalid(`Der Effekt „${effect.kind}“ wird noch nicht unterstützt.`);
    }
  }
  const recipeIds = new Set();
  const combinations = new Set();
  const recipes = list(input.recipes, 'Kombinationen', CATALOG_LIMITS.recipes).map((raw) => {
    object(raw, 'Kombination');
    const id = identifier(raw.id, 'Kombinations-ID');
    if (recipeIds.has(id)) invalid(`Die Kombinations-ID „${id}“ ist doppelt.`);
    recipeIds.add(id);
    const ingredients = {};
    const ingredientEntries = Object.entries(object(raw.ingredients, 'Zutaten'));
    if (!ingredientEntries.length || ingredientEntries.length > 30) invalid('Eine Kombination braucht 1 bis 30 unterschiedliche Zutaten.');
    for (const [type, count] of ingredientEntries) {
      reference(cardTypes, type, 'Zutat');
      if (type === 'human') invalid('Wähle „Mensch erforderlich“, statt Menschen als Zutat zu verbrauchen.');
      ingredients[type] = number(count, 'Zutatenmenge', 1, 100);
    }
    if (Object.values(ingredients).reduce((sum, count) => sum + count, 0) > 200) invalid('Eine Kombination darf höchstens 200 Zutaten enthalten.');
    if (raw.requiresHuman !== undefined && typeof raw.requiresHuman !== 'boolean') invalid('„Mensch erforderlich“ muss ja oder nein sein.');
    const requiresHuman = raw.requiresHuman ?? true;
    const signature = JSON.stringify(Object.entries(ingredients).sort(([a], [b]) => a.localeCompare(b)));
    if (combinations.has(signature)) invalid('Zwei Kombinationen haben dieselben Zutaten und wären nicht eindeutig.');
    combinations.add(signature);
    const timeBase = raw.timeBase ?? 'world';
    if (!['world', 'real'].includes(timeBase)) invalid('Ungültige Zeitbasis der Kombination.');
    const keepIngredients = [...new Set(list(raw.keepIngredients ?? [], 'Erhaltene Zutaten', 30).map((type) => {
      reference(cardTypes, type, 'Erhaltene Zutat');
      if (!Object.hasOwn(ingredients, type)) invalid('Eine erhaltene Zutat muss auf dem Zutatenstapel liegen.');
      return type;
    }))];
    return { id, name: name(raw.name, 'Kombinationsname'), ingredients, duration: number(raw.duration, 'Kombinationsdauer in Millisekunden', 1000, CATALOG_LIMITS.duration),
      result: generatedReference(cardTypes, raw.result, 'Ergebnis'), resultCount: number(raw.resultCount ?? 1, 'Ergebnismenge', 1, 30), requiresHuman, timeBase, ...(keepIngredients.length ? { keepIngredients } : {}) };
  });
  const packIds = new Set();
  const packs = list(input.packs, 'Pakete', CATALOG_LIMITS.packs).map((raw) => {
    object(raw, 'Paket');
    const id = identifier(raw.id, 'Paket-ID');
    if (packIds.has(id)) invalid(`Die Paket-ID „${id}“ ist doppelt.`);
    packIds.add(id);
    const contents = list(raw.contents, 'Paketinhalt', CATALOG_LIMITS.cardTypes, 1).map((entry) => {
      object(entry, 'Paketinhalt');
      return { type: generatedReference(cardTypes, entry.type, 'Paketinhalt'), weight: number(entry.weight, 'Paketgewicht', 0.0001, 1_000_000, false) };
    });
    if (new Set(contents.map((entry) => entry.type)).size !== contents.length) invalid('Eine Karte darf pro Paket nur einmal mit einem Gewicht eingetragen sein.');
    return { id, name: name(raw.name, 'Paketname'), description: text(raw.description, 'Paketbeschreibung', 2000, ''), color: color(raw.color),
      price: number(raw.price, 'Paketpreis', 1, CATALOG_LIMITS.price), size: number(raw.size, 'Karten pro Paket', 1, CATALOG_LIMITS.size), contents };
  });
  for (const card of world?.cards || []) {
    if (!Object.hasOwn(cardTypes, card.type)) invalid(`„${getCardDefinition(world, card.type)?.name || card.type}“ kann nicht gelöscht werden: Es gibt noch Karten davon in der Welt.`);
    for (const entry of card.packContents || []) reference(cardTypes, entry.type, 'Inhalt eines bereits gekauften Pakets');
    // Legacy packages carry the old default distribution until their first edit.
    if (card.type === 'pack' && !card.packContents) for (const entry of PACKS[0].contents) reference(cardTypes, entry.type, 'Inhalt eines älteren Pakets');
  }
  for (const [packId, paid] of Object.entries(world?.shopPayments || {})) {
    if (paid > 0 && !packIds.has(packId)) invalid('Ein angezahltes Paket kann erst gelöscht werden, wenn es vollständig bezahlt ist.');
  }
  if ((world?.shopPaid || 0) > 0 && !packIds.has('basic')) invalid('Das angezahlte Basicpaket kann noch nicht gelöscht werden.');
  const oldPacks = getPacks(world);
  if (!packIds.has('basic')) invalid('Das Basicpaket ist ein festes Standardpaket und kann nicht gelöscht werden.');
  for (const type of ['berry', 'bone', 'meat']) reference(cardTypes, type, 'Bestehende Ernte- und Kampfmechanik');
  for (const pack of packs) {
    const paid = world?.shopPayments?.[pack.id] ?? (pack.id === 'basic' ? world?.shopPaid : 0) ?? 0;
    if (paid > 0 && oldPacks.find((old) => old.id === pack.id)?.price !== pack.price) invalid('Der Preis eines angezahlten Pakets kann erst nach dem Kauf geändert werden.');
  }
  return { revision: Number.isSafeInteger(input.revision) && input.revision >= 0 ? input.revision : 0, contentVersion: 3, cardTypes, recipes, packs };
}

export function applyCatalogCommand(world, command) {
  const revision = getCatalog(world).revision;
  if (!Number.isSafeInteger(command.baseCatalogRevision) || command.baseCatalogRevision !== revision) {
    throw Object.assign(new Error('Der Katalog wurde inzwischen geändert. Lade den aktuellen Stand und versuche es erneut.'), { status: 409 });
  }
  const catalog = validateCatalog(command.catalog, world);
  catalog.revision = revision + 1;
  world.catalog = catalog;
  return catalog;
}
