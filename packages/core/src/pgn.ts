import { parse, type ParseTree } from '@mliebelt/pgn-parser'
import { Chess, DEFAULT_POSITION } from 'chess.js'
import { createGame, getPosition, validatePosition, type GameDocument, type GameNode } from './game.js'

type ParsedMove = ParseTree['moves'][number]
const MAX_BYTES = 2 * 1024 * 1024
const MAX_GAMES = 100
const MAX_NODES = 20_000
const MAX_VARIATION_DEPTH = 32
const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*'])

function tagValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'value' in value && typeof value.value === 'string') return value.value
  return undefined
}

function commentsFor(move: ParsedMove): string[] {
  return [move.commentMove, move.commentAfter, move.commentDiag?.comment]
    .filter((comment): comment is string => typeof comment === 'string' && comment.trim().length > 0)
    .filter((comment, index, comments) => comments.indexOf(comment) === index)
}

/** Reject the entire PGN on any parse, legality, variant or resource-limit error. */
export function importPgn(text: string): GameDocument[] {
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error('PGN exceeds 2 MiB')
  let parsed: ParseTree[]
  try {
    parsed = parse(text, { startRule: 'games' }) as ParseTree[]
  } catch (error) {
    let offset: number | undefined
    let line: number | undefined
    let column: number | undefined
    if (error && typeof error === 'object' && 'location' in error) {
      const location = error.location
      if (location && typeof location === 'object' && 'start' in location) {
        const start = location.start
        if (start && typeof start === 'object') {
          if ('offset' in start && typeof start.offset === 'number') offset = start.offset
          if ('line' in start && typeof start.line === 'number') line = start.line
          if ('column' in start && typeof start.column === 'number') column = start.column
        }
      }
    }
    const prefix = offset === undefined ? '' : text.slice(0, offset)
    const completedGames = (prefix.match(/(?:^|\s)(?:1-0|0-1|1\/2-1\/2|\*)(?=\s|$)/g) ?? []).length
    const gameNumber = completedGames + 1
    const context = line === undefined ? '' : ` at line ${line}, column ${column}`
    throw new Error(`Game ${gameNumber}, PGN syntax${context}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed.length > MAX_GAMES) throw new Error('PGN exceeds 100 games')
  const documents: GameDocument[] = []
  let nodeCount = 0

  for (const [gameIndex, source] of parsed.entries()) {
    const rawTags = (source.tags ?? {}) as Record<string, unknown>
    const variant = tagValue(rawTags.Variant)
    if (variant && !['standard', 'chess'].includes(variant.toLowerCase())) {
      throw new Error(`Game ${gameIndex + 1}: unsupported chess variant ${variant}`)
    }
    const rootFen = tagValue(rawTags.FEN) ?? DEFAULT_POSITION
    let document: GameDocument
    try {
      document = createGame(rootFen, tagValue(rawTags.Event) || 'Imported Game')
    } catch (error) {
      throw new Error(`Game ${gameIndex + 1}: invalid starting FEN: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const [key, value] of Object.entries(rawTags)) {
      const normalized = tagValue(value)
      if (normalized !== undefined) document.headers[key] = normalized
    }
    if (source.gameComment?.comment?.trim()) document.nodes[document.rootId].comments.push(source.gameComment.comment)
    nodeCount++
    if (nodeCount > MAX_NODES) throw new Error('PGN exceeds 20,000 nodes')

    function readLine(moves: ParsedMove[], parentId: string, chess: Chess, path: string[], depth: number, label: string): string {
      let currentId = parentId
      for (const [index, move] of moves.entries()) {
        const parent = document.nodes[currentId]
        const beforePath = path.slice()
        const san = move.notation?.notation
        const ply = beforePath.length + 1
        if (!san) throw new Error(`Game ${gameIndex + 1}, variation ${label}, ply ${ply}: missing move notation`)
        let played
        try {
          played = chess.move(san)
        } catch {
          throw new Error(`Game ${gameIndex + 1}, variation ${label}, ply ${ply}: illegal move ${san}`)
        }
        const uci = `${played.from}${played.to}${played.promotion ?? ''}`
        let node = parent.childIds.map(id => document.nodes[id]).find(child => child.uci === uci)
        if (!node) {
          const id = crypto.randomUUID()
          node = { id, parentId: currentId, childIds: [], fen: chess.fen({ forceEnpassantSquare: true }),
            san: played.san, uci, comments: [], nags: [] }
          document.nodes[id] = node
          parent.childIds.push(id)
          nodeCount++
          if (nodeCount > MAX_NODES) throw new Error('PGN exceeds 20,000 nodes')
        }
        node.comments.push(...commentsFor(move))
        for (const nag of move.nag ?? []) {
          if (!/^\$\d+$/.test(nag)) throw new Error(`Game ${gameIndex + 1}, variation ${label}, ply ${ply}: invalid NAG ${nag}`)
          node.nags.push(Number(nag.slice(1)))
        }
        path.push(uci)
        for (const [variationIndex, variation] of (move.variations ?? []).entries()) {
          if (depth >= MAX_VARIATION_DEPTH) {
            throw new Error(`Game ${gameIndex + 1}, variation ${label}.${variationIndex + 1}, ply ${ply}: nesting exceeds 32`)
          }
          // A variation replaces THIS move, not the previous move; retain the complete root history.
          readLine(variation, currentId,
            validatePosition({ initialFen: document.rootFen, moves: beforePath }), beforePath,
            depth + 1, `${label}.${index + 1}.${variationIndex + 1}`)
        }
        currentId = node.id
      }
      return currentId
    }

    document.currentId = readLine(source.moves, document.rootId,
      validatePosition({ initialFen: document.rootFen, moves: [] }), [], 0, 'mainline')
    documents.push(document)
  }
  return documents
}

function cleanComment(comment: string): string {
  return comment.replace(/[{}\x00-\x1f\x7f]/g, character => character === '{' ? '(' : character === '}' ? ')' : ' ').trim()
}

function escapedTag(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Serialize a complete tree, including sibling variations, from its original FEN. */
export function exportPgn(game: GameDocument): string {
  const headers = { ...game.headers }
  if (game.rootFen !== DEFAULT_POSITION) {
    headers.SetUp = '1'
    headers.FEN = game.rootFen
  } else {
    delete headers.SetUp
    delete headers.FEN
  }
  const result = RESULTS.has(headers.Result) ? headers.Result : '*'
  headers.Result = result
  const tags = Object.entries(headers)
    .filter(([key]) => /^[A-Za-z][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `[${key} "${escapedTag(value)}"]`)
  const root = game.nodes[game.rootId]
  if (!root) throw new Error('Game root is missing')
  const tokens: string[] = []
  for (const comment of root.comments) {
    const clean = cleanComment(comment)
    if (clean) tokens.push(`{${clean}}`)
  }
  const rootChess = validatePosition({ initialFen: game.rootFen, moves: [] })

  function renderLine(firstId: string, position: Chess, siblings: boolean): string {
    const rendered: string[] = []
    let nodeId: string | undefined = firstId
    let showSiblings = siblings
    let firstMove = true
    while (nodeId) {
      const node: GameNode | undefined = game.nodes[nodeId]
      if (!node?.parentId || !node.uci) throw new Error('Invalid game tree')
      const parent = game.nodes[node.parentId]
      if (!parent?.childIds.includes(nodeId)) throw new Error('Invalid game tree')
      const turn = position.turn()
      const number = Number(position.fen().split(' ')[5])
      if (turn === 'w') rendered.push(`${number}.`)
      else if (firstMove) rendered.push(`${number}...`)
      let played
      try {
        played = position.move({ from: node.uci.slice(0, 2), to: node.uci.slice(2, 4), promotion: node.uci[4] })
      } catch {
        throw new Error(`Invalid game tree: illegal move ${node.uci}`)
      }
      rendered.push(played.san)
      for (const nag of node.nags) {
        if (!Number.isInteger(nag) || nag < 0 || nag > 255) throw new Error('Invalid game tree: invalid NAG')
        rendered.push(`$${nag}`)
      }
      for (const comment of node.comments) {
        const clean = cleanComment(comment)
        if (clean) rendered.push(`{${clean}}`)
      }
      if (showSiblings) {
        for (const alternative of parent.childIds) {
          if (alternative !== nodeId) {
            const parentChess = validatePosition(getPosition(game, parent.id))
            rendered.push(`(${renderLine(alternative, parentChess, false)})`)
          }
        }
      }
      nodeId = node.childIds[0]
      firstMove = false
      showSiblings = true
    }
    return rendered.join(' ')
  }
  if (root.childIds[0]) tokens.push(renderLine(root.childIds[0], rootChess, true))
  tokens.push(result)
  return `${tags.join('\n')}\n\n${tokens.join(' ')}`.trim()
}
