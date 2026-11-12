// Run with `npm test`. The thread list's order and sections (components/thread-list.tsx).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FocusArea, Request } from '../data.ts'
import { moveOwner, sortThreads, threadAction, threadGroups } from './thread-groups.ts'

const area = (id: string, change: Partial<FocusArea> = {}) => ({ id, name: id, status: 'kept', ownerRank: null, priorityRank: null, mergedInto: null, ...change }) as FocusArea
const request = (id: string, state: Request['state'], focusAreaId?: string, startedAtIso = '2026-11-01T00:00:00Z') => ({ id, state, focusAreaId, startedAtIso, next: state === 'your-move' || state === 'needs-check' ? { who: 'human', need: 'review', text: 'x' } : { who: 'bot', text: 'x' } }) as Request
const ids = (requests: Request[]) => requests.map((entry) => entry.id)

describe('sortThreads', () => {
  it('puts what waits on a person first, and the newest first within a state', () => {
    const sorted = sortThreads([
      request('shipped', 'shipped'), request('old-move', 'your-move', undefined, '2026-11-01T00:00:00Z'), request('working', 'working'),
      request('check', 'needs-check'), request('new-move', 'your-move', undefined, '2026-11-02T00:00:00Z'), request('idle', 'idle'),
    ])
    assert.deepEqual(ids(sorted), ['new-move', 'old-move', 'check', 'working', 'idle', 'shipped'])
  })
  it('puts a shipped request that still owes a person a step above work an agent has', () => {
    const owed = { ...request('shipped-owed', 'shipped'), next: { who: 'human', need: 'approval', text: 'x' } } as Request
    assert.deepEqual(ids(sortThreads([request('working', 'working'), owed])), ['shipped-owed', 'working'])
  })
})

describe('threadGroups', () => {
  const areas = [
    area('second', { priorityRank: 2 }), area('first', { priorityRank: 1 }), area('suggested', { status: 'suggested', priorityRank: 0 }),
    area('finished', { status: 'done' }), area('merged', { mergedInto: 'first' }), area('dismissed', { status: 'dismissed' }), area('empty'),
  ]

  it('lists areas in priority order, then Other, then what is not sorted yet', () => {
    const groups = threadGroups(areas, [
      request('unsorted', 'working'), request('other', 'working', 'other'), request('b', 'working', 'second'), request('a', 'working', 'first'),
      request('s', 'working', 'suggested'), request('d', 'shipped', 'finished'),
    ])
    assert.deepEqual(groups.map((group) => group.key), ['first', 'second', 'empty', 'suggested', 'finished', 'other', 'not-sorted'])
    assert.deepEqual(groups.map((group) => group.kind), ['area', 'area', 'area', 'area', 'area', 'other', 'sorting'])
  })

  it('keeps a kept area with no requests in the owner\'s order, and leaves every other empty group out', () => {
    const owned = [area('later', { ownerRank: 2 }), area('sooner', { ownerRank: 1 }), area('suggested', { status: 'suggested' }), area('finished', { status: 'done' }), area('merged', { mergedInto: 'sooner' })]
    assert.deepEqual(threadGroups(owned, []).map((group) => [group.key, group.requests.length]), [['sooner', 0], ['later', 0]])
    const moved = threadGroups(owned, [request('a', 'working', 'later')])
    assert.deepEqual(moved.map((group) => [group.key, ids(group.requests)]), [['sooner', []], ['later', ['a']]])
  })

  it('shows every request exactly once: a merged area\'s under its target, a dismissed or unknown area\'s as not sorted', () => {
    const requests = [request('m', 'working', 'merged'), request('x', 'working', 'dismissed'), request('u', 'working', 'nowhere'), request('a', 'your-move', 'first')]
    const groups = threadGroups(areas, requests)
    assert.deepEqual(groups.map((group) => [group.key, ids(group.requests)]), [['first', ['a', 'm']], ['second', []], ['empty', []], ['not-sorted', ['x', 'u']]])
    assert.equal(groups.flatMap((group) => group.requests).length, requests.length)
  })
})

describe('moveOwner', () => {
  it('names another person only in the team view', () => {
    assert.equal(moveOwner({ askedBy: 'Sam' }, { team: false, name: 'Alex' }), null)
    assert.equal(moveOwner({ askedBy: 'Alex' }, { team: true, name: 'Alex' }), null)
    assert.equal(moveOwner({ askedBy: 'Sam' }, { team: true, name: 'Alex' }), 'Sam')
  })
})

describe('threadAction', () => {
  const chat = { tool: 'Claude Code', title: 'Thread', transcriptHref: '/api/work-view/evidence/prompt/1' }
  const suggestion = { conversationKey: 'c', requestId: 'r', requestTitle: 'Other', evidence: '' }
  const thread = (change: Partial<Request>) => ({ state: 'your-move', next: { who: 'human', need: 'answer', text: 'x' }, chat, ...change }) as Request

  it('offers nothing on an agent\'s move', () => {
    assert.equal(threadAction(thread({ state: 'working', next: { who: 'bot', text: 'x' }, suggestion })), 'none')
  })

  it('marks a review checked in place, and sends a decision that needs reading to the request page', () => {
    const review = thread({ state: 'needs-check', next: { who: 'human', need: 'review', text: 'x' } })
    assert.equal(threadAction(review), 'mark-checked')
    assert.equal(threadAction({ ...review, review: { mode: 'shared', hash: null, available: true, conflict: true } }), 'open-request')
    assert.equal(threadAction({ ...review, review: { mode: 'shared', hash: null, available: false } }), 'open-request')
  })

  it('answers a grouping suggestion in place only when an approval is what is needed', () => {
    assert.equal(threadAction(thread({ next: { who: 'human', need: 'approval', text: 'x' }, suggestion })), 'answer-suggestion')
    assert.equal(threadAction(thread({ next: { who: 'human', need: 'approval', text: 'x' } })), 'open-chat')
    assert.equal(threadAction(thread({ suggestion })), 'open-chat')
  })

  it('opens the chat for an answer, and offers nothing when no chat can be opened', () => {
    assert.equal(threadAction(thread({})), 'open-chat')
    assert.equal(threadAction(thread({ chat: { platform: 'claude', sessionId: 'not-a-uuid' } })), 'none')
    assert.equal(threadAction(thread({ chat: undefined })), 'none')
  })
})
