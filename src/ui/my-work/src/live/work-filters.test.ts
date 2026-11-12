import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SAMPLE_REQUESTS, type Request } from '../data.ts'
import { WORK_LIST_VIEWS, type WorkFilter } from '../store/store-types.ts'
import { boardColumns } from './board-columns.ts'
import { FILTER_MATCHES, filterFitsView, shownFilter } from './work-filters.ts'

const FILTERS = Object.keys(FILTER_MATCHES) as WorkFilter[]
const closed: Request = { ...SAMPLE_REQUESTS[0], id: 'closed', closed: true, state: 'idle', next: { who: 'bot', text: 'Nothing' } }
const requests = [...SAMPLE_REQUESTS, closed]

test('every filter the board offers puts each request it counts on a column', () => {
  for (const filter of FILTERS.filter((entry) => filterFitsView(entry, 'board'))) {
    const counted = requests.filter(FILTER_MATCHES[shownFilter('board', filter)])
    const cards = boardColumns(counted).flatMap((entry) => entry.requests)
    assert.equal(cards.length, counted.length, filter)
  }
})

test('Closed is a list filter: the board shows All for it, and every other view keeps it', () => {
  assert.equal(requests.filter(FILTER_MATCHES.closed).length, 1)
  assert.equal(filterFitsView('closed', 'board'), false)
  assert.equal(shownFilter('board', 'closed'), 'all')
  for (const view of WORK_LIST_VIEWS.filter((entry) => entry !== 'board')) assert.equal(shownFilter(view, 'closed'), 'closed')
  for (const filter of FILTERS.filter((entry) => entry !== 'closed')) assert.equal(shownFilter('board', filter), filter)
})
