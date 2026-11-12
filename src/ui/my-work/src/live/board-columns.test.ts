import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HUMAN_NEEDS, SAMPLE_REQUESTS, type LiveState, type Request } from '../data.ts'
import { BOARD_COLUMNS, boardColumn, boardColumns } from './board-columns.ts'

const STATES: LiveState[] = ['working', 'needs-check', 'your-move', 'idle', 'shipped']
const variant = (id: string, change: Partial<Request>): Request => ({ ...SAMPLE_REQUESTS[0], id, closed: undefined, ...change })
const everyShape: Request[] = [
  ...SAMPLE_REQUESTS,
  ...STATES.map((state) => variant(`bot-${state}`, { state, next: { who: 'bot', text: 'Keep going' } })),
  ...STATES.flatMap((state) => HUMAN_NEEDS.map((need) => variant(`human-${state}-${need}`, { state, next: { who: 'human', need, text: 'Your turn' } }))),
]

test('every request that is not closed sits in exactly one column, and a closed one in none', () => {
  const closed = variant('closed', { closed: true, state: 'idle', next: { who: 'bot', text: 'Nothing' } })
  const columns = boardColumns([...everyShape, closed])
  assert.deepEqual(columns.map((entry) => entry.column), [...BOARD_COLUMNS])
  const placed = columns.flatMap((entry) => entry.requests.map((request) => request.id))
  const open = everyShape.filter((request) => !request.closed).map((request) => request.id)
  assert.deepEqual([...placed].sort(), [...open].sort())
  assert.equal(new Set(placed).size, placed.length)
  assert.equal(boardColumn(closed), null)
})

test('a step that waits on a person is filed by what it needs, whatever the state says', () => {
  const column = (change: Partial<Request>) => boardColumn(variant('x', change))
  assert.equal(column({ state: 'your-move', next: { who: 'human', need: 'answer', text: 'Pick one' } }), 'answer')
  assert.equal(column({ state: 'needs-check', next: { who: 'human', need: 'review', text: 'Check it' } }), 'review')
  assert.equal(column({ state: 'your-move', next: { who: 'human', need: 'approval', text: 'Ship it' } }), 'approve')
  assert.equal(column({ state: 'shipped', next: { who: 'human', need: 'approval', text: 'Approve the follow-up' } }), 'approve')
  assert.equal(column({ state: 'working', next: { who: 'bot', text: 'Build' } }), 'working')
  assert.equal(column({ state: 'idle', next: { who: 'bot', text: 'Wait' } }), 'idle')
  assert.equal(column({ state: 'shipped', next: { who: 'bot', text: 'Done' } }), 'shipped')
})

test('a column lists its newest thread first', () => {
  const idle = (id: string, startedAtIso: string) => variant(id, { state: 'idle', startedAtIso, next: { who: 'bot', text: 'Wait' } })
  const [older, newer] = [idle('older', '2026-10-01T00:00:00Z'), idle('newer', '2026-10-09T00:00:00Z')]
  assert.deepEqual(boardColumns([older, newer]).find((entry) => entry.column === 'idle')!.requests.map((request) => request.id), ['newer', 'older'])
})
