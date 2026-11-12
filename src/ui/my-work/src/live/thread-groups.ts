// The thread list's order and sections. Recorded placement only, as in focus-overview.ts: a request with no live
// placement is listed as not sorted yet, never filed under a guessed area.
import { ATTENTION_ORDER, OTHER_FOCUS_AREA_ID, startedTimestamp, type FocusArea, type Request } from '../data.ts'
import { byFocusPriority, resolveFocusAreaId } from './to-focus-model.ts'
import { focusOverview } from './focus-overview.ts'
import { chatHref, requestChat } from './chat-links.ts'

/** A person's move first, whatever its state (a shipped request can still owe an approval), then what is moving, then the rest; newest first within a state. */
export function sortThreads(requests: readonly Request[]): Request[] {
  const onAgent = (request: Request) => request.next.who === 'human' ? 0 : 1
  return [...requests].sort((a, b) => onAgent(a) - onAgent(b) || ATTENTION_ORDER.indexOf(a.state) - ATTENTION_ORDER.indexOf(b.state) || startedTimestamp(b) - startedTimestamp(a))
}

export type ThreadGroup =
  | { kind: 'area'; key: string; area: FocusArea; requests: Request[] }
  | { kind: 'other'; key: string; requests: Request[] }
  | { kind: 'sorting'; key: string; requests: Request[] }

/**
 * Every request once: under its focus area in priority order (kept, then suggested, then any other live
 * area such as one marked done), then Other, then the ones not sorted yet. A kept area is listed even with no
 * requests, since its line is where the owner reads its notes, plans it and moves it; any other empty group is left out.
 */
export function threadGroups(areas: readonly FocusArea[], requests: readonly Request[]): ThreadGroup[] {
  const overview = focusOverview(areas, requests)
  const ranked = [...overview.areas, ...overview.suggested].map((row) => row.area)
  const rest = areas.filter((area) => !ranked.includes(area) && resolveFocusAreaId(area.id, areas) === area.id).sort(byFocusPriority)
  const inArea = (area: FocusArea) => requests.filter((request) => resolveFocusAreaId(request.focusAreaId, areas) === area.id)
  const groups: ThreadGroup[] = [
    ...[...ranked, ...rest].map((area): ThreadGroup => ({ kind: 'area', key: area.id, area, requests: sortThreads(inArea(area)) })),
    { kind: 'other', key: OTHER_FOCUS_AREA_ID, requests: sortThreads(overview.other) },
    { kind: 'sorting', key: 'not-sorted', requests: sortThreads(overview.sorting) },
  ]
  return groups.filter((group) => group.requests.length > 0 || (group.kind === 'area' && group.area.status === 'kept'))
}

/**
 * Whose move a human step is, as a name: null means the person reading ("You"). Only the team view names someone
 * else, and only when another person asked for the request.
 */
export function moveOwner(request: Pick<Request, 'askedBy'>, viewer: { team: boolean; name: string }): string | null {
  return viewer.team && request.askedBy !== viewer.name ? request.askedBy : null
}

/** What a person can do from a thread's row. One definition; the row's controls are a switch over it. */
export const THREAD_ACTIONS = ['none', 'mark-checked', 'open-request', 'answer-suggestion', 'open-chat'] as const
export type ThreadAction = (typeof THREAD_ACTIONS)[number]

/**
 * The row's action, from what the next step needs. A review is marked checked in place, unless its saved decision
 * needs reading first (unavailable or in conflict), which the request page handles. An approval of a grouping
 * suggestion is answered in place. Anything else a person owes is said in the chat itself: nothing here can deliver
 * a reply into an agent session.
 */
export function threadAction(request: Pick<Request, 'id' | 'next' | 'state' | 'review' | 'suggestion' | 'chat'>): ThreadAction {
  if (request.next.who !== 'human') return 'none'
  if (request.next.need === 'review') {
    return request.state === 'needs-check' && request.review?.available !== false && !request.review?.conflict ? 'mark-checked' : 'open-request'
  }
  if (request.next.need === 'approval' && request.suggestion) return 'answer-suggestion'
  return chatHref(requestChat(request)) !== undefined ? 'open-chat' : 'none'
}
