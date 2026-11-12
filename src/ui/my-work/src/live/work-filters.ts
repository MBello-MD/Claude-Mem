// My Work's filters: which requests each one shows, and which of them a view can show at all.
import { needsYou, type Request } from '../data.ts'
import type { WorkFilter, WorkListView } from '../store/store-types.ts'

/** Closed requests (every item dropped) show only under Closed. */
export const FILTER_MATCHES: Record<WorkFilter, (request: Request) => boolean> = {
  all: (request) => !request.closed,
  'needs-you': (request) => !request.closed && needsYou(request),
  working: (request) => !request.closed && request.state === 'working',
  shipped: (request) => !request.closed && request.state === 'shipped',
  closed: (request) => !!request.closed,
}

/** A closed request is on no board column (board-columns.ts), so the board does not offer Closed: it would be six empty columns. */
export const filterFitsView = (filter: WorkFilter, view: WorkListView): boolean => !(view === 'board' && filter === 'closed')

/** The filter a view applies for the saved choice: a choice the view cannot show reads as All there, and comes back with a view that can. */
export const shownFilter = (view: WorkListView, saved: WorkFilter): WorkFilter => filterFitsView(saved, view) ? saved : 'all'
