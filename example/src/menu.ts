/**
 * The menu.
 *
 * Every variety gets its own emoji and hue so a wall of two hundred orders is
 * actually readable — you can see at a glance that the queue produced a mix,
 * and which ones are still missing.
 */

export type ItemKind = 'tea' | 'pie'

export interface MenuItem {
  id: string
  kind: ItemKind
  name: string
  emoji: string
  /** CSS hue, 0–360, used for the card's accent. */
  hue: number
}

/** Teas are quick. */
export const TEA_BREW_MS = 200

/** Pies are not. */
export const PIE_BAKE_MS = 1_000

export const TEAS: readonly MenuItem[] = [
  { id: 'earl-grey', kind: 'tea', name: 'Earl Grey', emoji: '🫖', hue: 215 },
  { id: 'jasmine', kind: 'tea', name: 'Jasmine', emoji: '🌸', hue: 330 },
  { id: 'sencha', kind: 'tea', name: 'Sencha', emoji: '🍃', hue: 130 },
  { id: 'rooibos', kind: 'tea', name: 'Rooibos', emoji: '🍂', hue: 20 },
  { id: 'peppermint', kind: 'tea', name: 'Peppermint', emoji: '🌿', hue: 160 },
  { id: 'assam', kind: 'tea', name: 'Assam', emoji: '🍁', hue: 35 },
  { id: 'oolong', kind: 'tea', name: 'Oolong', emoji: '🍵', hue: 95 },
  { id: 'chamomile', kind: 'tea', name: 'Chamomile', emoji: '🌼', hue: 50 },
  { id: 'lapsang', kind: 'tea', name: 'Lapsang Souchong', emoji: '🔥', hue: 8 },
  { id: 'masala-chai', kind: 'tea', name: 'Masala Chai', emoji: '🧉', hue: 30 },
]

export const PIES: readonly MenuItem[] = [
  { id: 'apple', kind: 'pie', name: 'Apple', emoji: '🍎', hue: 0 },
  { id: 'cherry', kind: 'pie', name: 'Cherry', emoji: '🍒', hue: 345 },
  { id: 'pecan', kind: 'pie', name: 'Pecan', emoji: '🌰', hue: 25 },
  { id: 'key-lime', kind: 'pie', name: 'Key Lime', emoji: '🍈', hue: 85 },
  { id: 'blueberry', kind: 'pie', name: 'Blueberry', emoji: '🫐', hue: 240 },
  { id: 'banoffee', kind: 'pie', name: 'Banoffee', emoji: '🍌', hue: 48 },
  { id: 'pumpkin', kind: 'pie', name: 'Pumpkin', emoji: '🎃', hue: 28 },
  { id: 'steak-ale', kind: 'pie', name: 'Steak & Ale', emoji: '🥩', hue: 355 },
  { id: 'lemon', kind: 'pie', name: 'Lemon Meringue', emoji: '🍋', hue: 55 },
  { id: 'chocolate', kind: 'pie', name: 'Chocolate Silk', emoji: '🍫', hue: 15 },
]

const BY_ID = new Map<string, MenuItem>(
  [...TEAS, ...PIES].map((item) => [item.id, item]),
)

/** Looks a variety up, or `undefined` if the menu has changed under us. */
export function findItem(id: string): MenuItem | undefined {
  return BY_ID.get(id)
}

/** Picks something at random off the given part of the menu. */
export function pickRandom(kind: ItemKind): MenuItem {
  const options = kind === 'tea' ? TEAS : PIES
  const index = Math.floor(Math.random() * options.length)
  return options[index] as MenuItem
}

/** How long this kind of thing takes to make. */
export function preparationMs(kind: ItemKind): number {
  return kind === 'tea' ? TEA_BREW_MS : PIE_BAKE_MS
}
