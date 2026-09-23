import { openDB, type IDBPDatabase } from 'idb'
import type { GameDocument } from '@chessin/core/game'

let database: Promise<IDBPDatabase> | undefined

const knownRevisions = new Map<string, number | null>()
const memory = new Map<string, GameDocument>()
const unsavedGames = new Map<string, GameDocument>()
let pending: Promise<unknown> = Promise.resolve()

function db(): Promise<IDBPDatabase> {
  // Open lazily so synchronous SecurityError still leaves the board usable.
  return database ??= Promise.resolve().then(() => {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is unavailable. Export your game to keep it.')
    return openDB('chessin', 1, {
      upgrade(database) {
        database.createObjectStore('games', { keyPath: 'id' })
        database.createObjectStore('settings')
        database.createObjectStore('reviews')
      },
    })
  })
}

function serialize<T>(action: () => Promise<T>): Promise<T> {
  const result = pending.then(action)
  pending = result.catch(() => undefined)
  return result
}

export async function listGames(): Promise<GameDocument[]> {
  const games = await (await db()).getAll('games') as GameDocument[]
  for (const game of games) {
    knownRevisions.set(game.id, game.revision)
    memory.set(game.id, game)
  }
  return [...new Map([...games, ...memory.values()].map(game => [game.id, game])).values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function loadGame(id: string): Promise<GameDocument | undefined> {
  const game = (await (await db()).get('games', id)) as GameDocument | undefined
  knownRevisions.set(id, game?.revision ?? null)
  if (game) memory.set(id, game)
  return game ?? memory.get(id)
}

export function saveGame(game: GameDocument): Promise<GameDocument> {
  memory.set(game.id, game)
  unsavedGames.set(game.id, game)
  return serialize(async () => {
    const tx = (await db()).transaction('games', 'readwrite')
    const store = tx.objectStore('games')
    const persisted = await store.get(game.id) as GameDocument | undefined
    const expected = knownRevisions.get(game.id) ?? null
    let saved = game
    if (persisted && persisted.revision !== expected) {
      const now = new Date().toISOString()
      saved = { ...game, id: crypto.randomUUID(), title: `${game.title} (conflict copy)`, createdAt: now, updatedAt: now, revision: 0 }
    }
    await store.put(saved)
    await tx.done
    knownRevisions.set(saved.id, saved.revision)
    memory.set(saved.id, saved)
    if (saved.id !== game.id && persisted) memory.set(game.id, persisted)
    if (unsavedGames.get(game.id) === game) unsavedGames.delete(game.id)
    return saved
  })
}

export function deleteGame(id: string): Promise<void> {
  return serialize(async () => {
    const tx = (await db()).transaction('games', 'readwrite')
    await tx.objectStore('games').delete(id)
    await tx.done
    memory.delete(id)
    knownRevisions.delete(id)
    unsavedGames.delete(id)
  })
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('settings', key)) as T | undefined
}
export function putSetting(key: string, value: unknown): Promise<void> {
  return serialize(async () => { const tx = (await db()).transaction('settings', 'readwrite'); await tx.store.put(value, key); await tx.done })
}
export async function getReview<T>(id: string): Promise<T | undefined> {
  return (await (await db()).get('reviews', id)) as T | undefined
}
export function putReview(id: string, value: unknown): Promise<void> {
  return serialize(async () => { const tx = (await db()).transaction('reviews', 'readwrite'); await tx.store.put(value, id); await tx.done })
}
export function hasUnsavedGames(): boolean { return unsavedGames.size > 0 }
export async function flushSaves(): Promise<void> {
  for (;;) {
    const observed = pending
    await observed
    if (observed === pending) return
  }
}
