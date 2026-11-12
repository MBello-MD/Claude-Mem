// The board: the thread list's requests in columns, by what a person must do next. Nothing drags, because no
// write would mean a drop; a card opens its request or its chat.
import { useState } from 'react'
import { interpolate, useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { OTHER_FOCUS_AREA_ID, type FocusArea, type Request } from '@/data'
import { useFreshlyUpdated } from '@/store'
import { boardColumns, type BoardColumn } from '@/live/board-columns'
import { resolveFocusAreaId } from '@/live/to-focus-model'
import { ChatLinks, RISK, riskLabel, StatusDot, useRequestChatLinks } from './thread-list'

/** `newest`: the column grows without end, so it shows that many until asked for the rest. */
const COLUMN: Record<BoardColumn, { label: string; newest?: number }> = {
  answer: { label: 'Answer' },
  review: { label: 'Review' },
  approve: { label: 'Approve' },
  working: { label: 'Working' },
  idle: { label: 'Idle', newest: 5 },
  shipped: { label: 'Shipped', newest: 5 },
}

function focusName(request: Request, focusAreas: readonly FocusArea[], t: (text: string) => string) {
  const id = resolveFocusAreaId(request.focusAreaId, focusAreas)
  if (id === OTHER_FOCUS_AREA_ID) return t('Other')
  return focusAreas.find((area) => area.id === id)?.name ?? t('Sorting…')
}

function BoardCard({ request, focus, onOpen }: { request: Request; focus: string | null; onOpen: (request: Request) => void }) {
  const { t } = useI18n()
  const fresh = useFreshlyUpdated(request.id)
  const links = useRequestChatLinks(request)
  const next = request.question?.text ?? request.next.text
  return (
    <li title={riskLabel(request.risk, t)} className={cn('grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2 gap-y-1 rounded-md border bg-card px-2.5 py-2', request.risk && RISK[request.risk.level].row, fresh && 'just-updated')}>
      <span className="sr-only">{riskLabel(request.risk, t)}</span>
      <StatusDot state={request.state} />
      <button type="button" onClick={() => onOpen(request)} className={cn('min-w-0 rounded-sm text-left text-sm leading-snug font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring', !request.title && 'text-muted-foreground')}>
        {request.title ?? request.resolvesTo?.title ?? t('New request, title being written')}
      </button>
      <span className="-my-1 -mr-1.5">{links && <ChatLinks chat={links} showTranscript />}</span>
      <p className="col-span-2 col-start-2 line-clamp-2 text-xs leading-snug text-foreground/85" title={next}>{t(next)}</p>
      {focus && <p className="col-span-2 col-start-2 truncate text-xs text-muted-foreground">{focus}</p>}
    </li>
  )
}

function Column({ column, requests, focusAreas, showFocus, onOpen }: { column: BoardColumn; requests: Request[]; focusAreas: readonly FocusArea[]; showFocus: boolean; onOpen: (request: Request) => void }) {
  const { t } = useI18n()
  const [all, setAll] = useState(false)
  const { label, newest } = COLUMN[column]
  const shown = newest === undefined || all ? requests : requests.slice(0, newest)
  return (
    <section aria-label={t(label)} className="flex min-w-0 flex-col gap-2 md:max-h-[calc(100svh-13rem)]">
      <h2 className="flex items-baseline gap-2 px-1 text-sm font-semibold tracking-tight">{t(label)}<span className="text-xs font-normal text-muted-foreground tabular-nums">{requests.length}</span></h2>
      <ul className="min-h-0 space-y-2 md:overflow-y-auto">
        {shown.map((request) => <BoardCard key={request.id} request={request} focus={showFocus ? focusName(request, focusAreas, t) : null} onOpen={onOpen} />)}
      </ul>
      {shown.length < requests.length && <Button variant="ghost" size="sm" className="h-11 self-start px-1 text-xs text-muted-foreground md:h-7" onClick={() => setAll(true)}>{interpolate(t('Show all {count}'), { count: requests.length })}</Button>}
    </section>
  )
}

/** `showFocus` is off inside one focus area, where every card would name the same one. */
export function ThreadBoard({ requests, focusAreas, showFocus, onOpen }: { requests: Request[]; focusAreas: readonly FocusArea[]; showFocus: boolean; onOpen: (request: Request) => void }) {
  return (
    <Req ids={['R19.10', 'R11.1']}>
      <div className="grid grid-cols-1 gap-x-3 gap-y-6 md:grid-cols-3 xl:grid-cols-6">
        {boardColumns(requests).map((entry) => <Column key={entry.column} column={entry.column} requests={entry.requests} focusAreas={focusAreas} showFocus={showFocus} onOpen={onOpen} />)}
      </div>
    </Req>
  )
}
