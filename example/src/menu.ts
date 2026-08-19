/**
 * The menu.
 *
 * Every variety gets its own emoji and hue so a wall of two hundred orders is
 * actually readable — you can see at a glance that the queue produced a mix,
 * and which ones are still missing.
 */

export type ItemKind = 'tea' | 'pie' | 'showstopper'

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

/** Showstoppers are slower still, and they go wrong. */
export const SHOWSTOPPER_BAKE_MS = 1_500

/**
 * How often a showstopper collapses, per attempt.
 *
 * At one in two, with three attempts allowed, roughly seven out of eight make
 * it eventually — so most of them come out, a lot of them take two or three
 * goes, and every so often one is lost for good. Which is the whole point: it
 * is what a flaky dependency actually looks like in the dashboard.
 */
export const SHOWSTOPPER_FAILURE_RATE = 0.5

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

/** The hard bakes. Delicious when they work, which is about half the time. */
export const SHOWSTOPPERS: readonly MenuItem[] = [
  { id: 'souffle', kind: 'showstopper', name: 'Soufflé', emoji: '🍮', hue: 42 },
  { id: 'croquembouche', kind: 'showstopper', name: 'Croquembouche', emoji: '🎂', hue: 318 },
  { id: 'mille-feuille', kind: 'showstopper', name: 'Mille-Feuille', emoji: '🍰', hue: 285 },
  { id: 'baked-alaska', kind: 'showstopper', name: 'Baked Alaska', emoji: '🍨', hue: 195 },
  { id: 'macaron-tower', kind: 'showstopper', name: 'Macaron Tower', emoji: '🧁', hue: 335 },
  { id: 'tarte-tatin', kind: 'showstopper', name: 'Tarte Tatin', emoji: '🍏', hue: 105 },
  { id: 'sugar-dome', kind: 'showstopper', name: 'Spun Sugar Dome', emoji: '🍬', hue: 265 },
  { id: 'lattice-lemon', kind: 'showstopper', name: 'Lattice Lemon', emoji: '🥧', hue: 60 },
]

/** The ways a showstopper goes wrong. Picked at random for the error message. */
export const MISHAPS: readonly string[] = [
  'the soufflé sank in the tin ｡ﾟ(ﾟ´ω`ﾟ)ﾟ｡',
  'the caramel seized (>﹏<)',
  'the layers slid clean off (╯︵╰,)',
  'somebody slammed the oven door (⊙_⊙)',
  'the meringue wept ( ; ω ; )',
  'the spun sugar went sticky (ﾉ_<。)',
  'the tower leaned, then did not stop leaning (・_・;)',
  'the bottom was, regrettably, soggy (๑•́ ₃ •̀๑)',
]

const BY_ID = new Map<string, MenuItem>(
  [...TEAS, ...PIES, ...SHOWSTOPPERS].map((item) => [item.id, item]),
)

/** Looks a variety up, or `undefined` if the menu has changed under us. */
export function findItem(id: string): MenuItem | undefined {
  return BY_ID.get(id)
}

/** Everything on offer of one kind. */
export function menuFor(kind: ItemKind): readonly MenuItem[] {
  if (kind === 'tea') return TEAS
  if (kind === 'pie') return PIES
  return SHOWSTOPPERS
}

/** Picks something at random off the given part of the menu. */
export function pickRandom(kind: ItemKind): MenuItem {
  return pickOne(menuFor(kind))
}

/** How long this kind of thing takes to make. */
export function preparationMs(kind: ItemKind): number {
  if (kind === 'tea') return TEA_BREW_MS
  if (kind === 'pie') return PIE_BAKE_MS
  return SHOWSTOPPER_BAKE_MS
}

/** A random one of anything. */
export function pickOne<Value>(options: readonly Value[]): Value {
  return options[Math.floor(Math.random() * options.length)] as Value
}
