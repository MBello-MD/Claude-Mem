// My Work as a plain list of threads: one row per request, hairline dividers, no card chrome. Each row says what
// was asked, how risky it is, what happens next and who that waits on, and lets a person make their move from the row.
import { useEffect, useState } from 'react'
import { ObsMediaStrip } from './observation-media/ObsMedia'
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronRightIcon, MessageSquareIcon, SendIcon, TerminalIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { SaveButton } from '@/components/save-button'
import { Button, buttonVariants } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { ATTENTION_ORDER, isSampleHref, OTHER_FOCUS_AREA_ID, SAMPLE_PEOPLE, type FocusArea, type HumanNeed, type Request, type Risk } from '@/data'
import { STATE_DOT, STATE_LABEL } from './bits'
import { agentById, useFreshlyUpdated, useStore, useWorkModel, useWorkspace } from '@/store'
import { SOLO_REQUESTER } from '@/live/work-view-overview'
import { NEXT_STEP_NOT_RECORDED, NO_WORK_YET, UNRECORDED_AGENT } from '@/live/to-work-model'
import { chatLinks, requestChat, type ChatLinks as ChatLinkSet } from '@/live/chat-links'
import { moveOwner, sortThreads, threadAction, threadGroups, type ThreadAction, type ThreadGroup } from '@/live/thread-groups'
import { useCheckSave, useSuggestionSave } from './use-request-saves'
import { useFocusChanges, type FocusChanges } from './focus-changes'
import { byFocusPriority } from '@/live/to-focus-model'
import { MAX_ANSWER_CHARS, type AnswerRunState } from '../../../../services/work-view/owner-runs.mjs'
import { FocusNotes } from './focus-notes'
import { PlanButton, PlanProposals } from './focus-plan'

/** Green to red, from the last memory review, as the whole row's tint. A request no review has rated has no tint, never a guessed level. */
export const RISK: Record<Risk, { label: string; row: string }> = {
  low: { label: 'Risk: low', row: 'bg-risk-low/10' },
  medium: { label: 'Risk: medium', row: 'bg-risk-medium/12' },
  high: { label: 'Risk: high', row: 'bg-risk-high/12' },
}

export function riskLabel(risk: Request['risk'], t: (text: string) => string) {
  if (!risk) return t('Not rated yet')
  return risk.reason ? `${t(RISK[risk.level].label)}. ${risk.reason}` : t(RISK[risk.level].label)
}

/** Where the request stands, in the state colors the rest of My Work uses. */
export function StatusDot({ state }: { state: Request['state'] }) {
  const { t } = useI18n()
  return <span role="img" aria-label={t(STATE_LABEL[state])} title={t(STATE_LABEL[state])} className={cn('mt-[0.4rem] size-2 shrink-0 rounded-full', STATE_DOT[state])} />
}

const NEED_LABEL: Record<HumanNeed, string> = { answer: 'answer', review: 'review', approval: 'approval' }

/** Who the next step waits on: a person and what it needs from them, or the agent that has it. */
function WaitingOn({ request }: { request: Request }) {
  const { t } = useI18n()
  const { team } = useWorkspace()
  const { sourceKind } = useWorkModel()
  // An agent nobody recorded has no name worth a label.
  if (request.next.who === 'bot') return request.agentId === UNRECORDED_AGENT.id ? null : <span className="text-muted-foreground">{agentById(request.agentId).name}</span>
  // The sample has no signed-in person, so its first person stands in for the reader.
  const reader = sourceKind === 'sample' ? SAMPLE_PEOPLE[0] : SOLO_REQUESTER
  const who = moveOwner(request, { team, name: reader }) ?? t('You')
  return <span className="font-semibold text-attention-foreground">{interpolate(t('{who} · {need}'), { who, need: t(NEED_LABEL[request.next.need]) })}</span>
}

const CONTROL = 'h-11 shrink-0 md:h-7'
/** One grid for the column names and every row, so request, next step and why line up down the page and wrap inside their own column. */
const ROW = 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-1 md:grid-cols-[auto_minmax(0,4fr)_minmax(0,4fr)_minmax(0,3fr)_minmax(0,3fr)_11rem] md:gap-x-5'

/** A chat link. A sample has no transcript behind it, so it says so instead of opening a blank page (as ProductLink does). */
function ChatAnchor({ href, label, className, children }: { href: string; label?: string; className?: string; children: React.ReactNode }) {
  const { t } = useI18n()
  if (!isSampleHref(href)) return <a href={href} {...(href.startsWith('/') ? { target: '_blank', rel: 'noreferrer' } : {})} aria-label={label} title={label} className={className}>{children}</a>
  return (
    <Tooltip>
      <TooltipTrigger asChild><span tabIndex={0} role="link" aria-disabled="true" aria-label={label} className={cn('cursor-help', className)}>{children}</span></TooltipTrigger>
      <TooltipContent>{t('Sample link. The real page attaches when the agent records it.')}</TooltipContent>
    </Tooltip>
  )
}

type CopyState = 'idle' | 'copied' | 'failed'
const COPY_SHOWN_FOR_MS = 2000

/** Copies the command that reopens the session in its tool, and says so. */
export function CopyResumeCommand({ command }: { command: string }) {
  const { t } = useI18n()
  const [state, setState] = useState<CopyState>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const reset = setTimeout(() => setState('idle'), COPY_SHOWN_FOR_MS)
    return () => clearTimeout(reset)
  }, [state])
  const copy = () => navigator.clipboard.writeText(command).then(() => setState('copied'), () => setState('failed'))
  const label = interpolate(t('Copy the command that resumes this chat: {command}'), { command })
  return (
    <Button variant="ghost" size="sm" className={cn(CONTROL, 'min-w-11 px-2 text-xs text-muted-foreground md:min-w-7')} onClick={copy} aria-label={label} title={label}>
      {state === 'copied' ? <CheckIcon /> : <TerminalIcon />}
      <span role="status">{state === 'copied' ? t('Copied') : state === 'failed' ? t('Couldn’t copy') : ''}</span>
    </Button>
  )
}

/** The request's conversation, opened in its own tool where that tool has a link, else as the recorded transcript. */
export function ChatLinks({ chat, showTranscript }: { chat: ChatLinkSet; showTranscript: boolean }) {
  const { t } = useI18n()
  const href = chat.openHref ?? chat.transcriptHref
  const label = interpolate(t(chat.openHref ? 'Open in {tool}' : 'Open the recorded chat ({tool})'), { tool: chat.tool })
  return (
    <Req ids={['R19.2']}>
      <span className="inline-flex items-center">
        {showTranscript && href !== undefined && (
          <ChatAnchor href={href} label={label} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), CONTROL, 'min-w-11 px-2 text-muted-foreground md:min-w-7')}><MessageSquareIcon /></ChatAnchor>
        )}
      </span>
    </Req>
  )
}

/**
 * Stage: what the agent made, ready to look at. A stage that was made for the review names its format; without one,
 * the brief is the review's own words beside the real thing (its screenshots, its first deliverable). Both open the request.
 */
function StageCell({ request, onOpen }: { request: Request; onOpen: (request: Request) => void }) {
  const { t } = useI18n()
  const { stageFormats } = useWorkModel()
  const product = request.workProduct[0]
  const ready = request.readyStages?.[0]
  const staged = ready && t(stageFormats?.find((format) => format.id === ready)?.label ?? ready)
  return (
    <Req ids={['R19.7']}>
      <div className="col-start-2 min-w-0 space-y-1 md:col-start-auto">
        <button type="button" onClick={() => onOpen(request)} className="block max-w-full truncate rounded-sm text-left text-sm underline decoration-border underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-ring">
          {staged || (product ? product.label : t('Read the brief'))}
        </button>
        {request.media && <ObsMediaStrip media={{ version: 1, attachments: request.media.preview.slice(0, 2) }} total={request.media.count} title={request.title ?? t('Untitled request')} onMore={() => onOpen(request)} />}
      </div>
    </Req>
  )
}

const ANSWER_STATE: Record<AnswerRunState, string> = { answering: 'Sending…', delivered: 'Delivered', failed: 'Not delivered' }

/**
 * Answer the agent from the row: Send hands the answer to the request's own session, and the row says how that went.
 * A session the worker cannot send to refuses; the answer is then copied, to paste into the chat.
 */
function AnswerLine({ request, chatHref }: { request: Request; chatHref: string | undefined }) {
  const { t } = useI18n()
  const [answer, setAnswer] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<{ text: string; openChat?: true } | null>(null)
  const [background, setBackground] = useState<{ open: boolean; items?: { text: string }[]; error?: string }>({ open: false, items: request.question?.background })
  const run = request.answer
  const send = async () => {
    const text = answer.trim()
    if (!text) { setNotice({ text: t('Write an answer first.') }); return }
    setSending(true)
    setNotice(null)
    try {
      const started = await useStore.getState().answerRequest(request.id, text)
      if (started.outcome !== 'refused') { setAnswer(''); return }
      const copied = await navigator.clipboard.writeText(text).then(() => true, () => false)
      setNotice({ text: `${started.reason} ${t(copied ? 'Answer copied. Paste it into the chat.' : 'Couldn’t copy your answer. Copy it, then open the chat.')}`, openChat: true })
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error) })
    } finally { setSending(false) }
  }
  // Offered only when something was gathered for the question: on the row itself, or waiting in its detail.
  const hasBackground = !!(background.items ? background.items.length : request.question?.hasBackground)
  const showBackground = async () => {
    if (background.open) { setBackground({ ...background, open: false }); return }
    if (background.items || request.detailLoaded !== false) { setBackground({ ...background, open: true }); return }
    try {
      const detail = await useStore.getState().loadRequestDetail(request)
      setBackground({ open: true, items: detail.question?.background ?? [] })
    } catch (error) {
      setBackground({ open: true, items: [], error: error instanceof Error ? error.message : String(error) })
    }
  }
  return (
    <Req ids={['R19.8']}>
      <div className="col-start-2 space-y-1.5 md:col-span-5">
        <form className="flex max-w-2xl items-center gap-2" onSubmit={(event) => { event.preventDefault(); void send() }}>
          <input value={answer} onChange={(event) => { setAnswer(event.target.value); setNotice(null) }} aria-label={t('Your answer')} placeholder={t('Your answer')} maxLength={MAX_ANSWER_CHARS}
            className="h-11 min-w-0 flex-1 rounded-md border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-8" />
          <Button type="submit" variant="outline" size="sm" className={CONTROL} disabled={sending || run?.state === 'answering'}><SendIcon />{t('Send')}</Button>
          {hasBackground && <Button type="button" variant="ghost" size="sm" className={cn(CONTROL, 'text-muted-foreground')} aria-expanded={background.open} onClick={() => void showBackground()}>{t('What you may need')}</Button>}
        </form>
        {notice ? (
          <p role="status" className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {notice.text}
            {notice.openChat && chatHref !== undefined && <ChatAnchor href={chatHref} className="underline underline-offset-4 hover:text-foreground">{t('Open chat')}</ChatAnchor>}
          </p>
        ) : run && (
          <Req ids={['R19.12']}>
            <p role="status" className={cn('text-xs text-muted-foreground', run.state === 'failed' && 'text-attention-foreground')}>{t(ANSWER_STATE[run.state])}{run.state === 'failed' && run.error ? `: ${run.error}` : ''}</p>
          </Req>
        )}
        {background.open && (background.error ? <p role="alert" className="text-xs text-muted-foreground">{background.error}</p>
          : !!background.items?.length && <ul className="max-w-2xl list-disc space-y-0.5 pl-5 text-sm text-foreground/85">{background.items.map((item, index) => <li key={index}>{item.text}</li>)}</ul>)}
      </div>
    </Req>
  )
}

/** The links to a request's chat. A sample session exists nowhere, so its link says so and opens nothing. */
export function useRequestChatLinks(request: Parameters<typeof requestChat>[0]): ChatLinkSet | undefined {
  const sample = useWorkModel().sourceKind === 'sample'
  const chat = requestChat(request)
  return chat && (sample ? { ...chatLinks(chat), openHref: '#' } : chatLinks(chat))
}

function ThreadRow({ request, onOpen }: { request: Request; onOpen: (request: Request) => void }) {
  const { t } = useI18n()
  const fresh = useFreshlyUpdated(request.id)
  const check = useCheckSave(request)
  const suggestion = useSuggestionSave(request.suggestion)
  const notice = check.notice ?? suggestion.notice
  const action = threadAction(request)
  const links = useRequestChatLinks(request)
  const href = links?.openHref ?? links?.transcriptHref
  const answering = request.next.who === 'human' && request.next.need === 'answer'
  const reviewing = request.next.who === 'human' && request.next.need === 'review'
  const controls: Record<ThreadAction, React.ReactNode> = {
    none: null,
    'mark-checked': <SaveButton className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), CONTROL)} onClick={() => check.save(true)} disabled={check.saving}><CheckIcon />{t('Mark checked')}</SaveButton>,
    'open-request': <Button variant="outline" size="sm" className={CONTROL} onClick={() => onOpen(request)}>{t('Open request')}</Button>,
    'answer-suggestion': (
      <>
        <SaveButton className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), CONTROL)} onClick={() => suggestion.save('join')} disabled={suggestion.saving} title={request.suggestion && interpolate(t('Join “{title}”'), { title: request.suggestion.requestTitle })}>{t('Join')}</SaveButton>
        <SaveButton className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), CONTROL)} onClick={() => suggestion.save('not-this')} disabled={suggestion.saving}>{t('Not this')}</SaveButton>
      </>
    ),
    // An answer is given on the line below; an approval with nothing to save here is said in the chat.
    'open-chat': !answering && href !== undefined && (
      <ChatAnchor href={href} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), CONTROL)}><MessageSquareIcon />{t('Open chat')}</ChatAnchor>
    ),
  }
  const next = request.question?.text ?? request.next.text
  const nextRecorded = next !== NEXT_STEP_NOT_RECORDED && next !== NO_WORK_YET
  return (
    <Req ids={['R19.5']}>
      <li title={riskLabel(request.risk, t)} className={cn(ROW, 'items-start rounded-md px-2 py-2.5', request.risk && RISK[request.risk.level].row, fresh && 'just-updated')}>
        <span className="sr-only">{riskLabel(request.risk, t)}</span>
        <StatusDot state={request.state} />
        <Req ids={['R2.6', 'R10.5']}>
          <button type="button" onClick={() => onOpen(request)} className={cn('min-w-0 rounded-sm text-left text-[0.92rem] leading-snug font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring', !request.title && 'text-muted-foreground')}>
            {request.title ?? request.resolvesTo?.title ?? t('New request, title being written')}
          </button>
        </Req>
        <Req ids={['R19.3', 'R5.8', 'R9.3']}>
          <p className={cn('col-start-2 min-w-0 text-sm leading-snug md:col-start-auto', !request.question && 'md:line-clamp-2')} title={next}><WaitingOn request={request} /> <span className={nextRecorded ? 'text-foreground/85' : 'text-muted-foreground/70'}>{t(next)}</span></p>
        </Req>
        <Req ids={['R19.6']}>
          <p className="col-start-2 min-w-0 text-sm leading-snug text-muted-foreground md:col-start-auto md:line-clamp-2" title={request.why}>{request.why}</p>
        </Req>
        {reviewing ? <StageCell request={request} onOpen={onOpen} /> : <span className="hidden md:block" />}
        <span className="col-start-2 inline-flex items-center gap-1 md:col-start-auto md:justify-end">
          <Req ids={['R19.4', 'R6.3']}>{controls[action]}</Req>
          {links && <ChatLinks chat={links} showTranscript={action !== 'open-chat' || answering} />}
        </span>
        {answering && <AnswerLine request={request} chatHref={href} />}
        {notice && <p role="status" className={cn('col-start-2 text-xs md:col-span-5', notice.tone === 'problem' ? 'font-medium text-foreground' : 'text-muted-foreground')}>{t(notice.message)}</p>}
      </li>
    </Req>
  )
}

function Rows({ requests, onOpen }: { requests: Request[]; onOpen: (request: Request) => void }) {
  return <ul className="space-y-px">{requests.map((request) => <ThreadRow key={request.id} request={request} onOpen={onOpen} />)}</ul>
}

function ColumnNames() {
  const { t } = useI18n()
  return (
    <div aria-hidden="true" className={cn(ROW, 'hidden px-2 text-xs text-muted-foreground md:grid')}>
      <span className="size-2" /><span>{t('Request')}</span><span>{t('Next step')}</span><span>{t('Why')}</span><span>{t('Stage')}</span><span />
    </div>
  )
}

const COUNTED_STATES: readonly Request['state'][] = ATTENTION_ORDER

/** One focus, closed: its name (the goal is its hover text), how many chats it holds in each state, and its place in the owner's order. */
function FocusLine({ group, open, onToggle, onOpenFocus, order, changes }: { group: ThreadGroup; open: boolean; onToggle: () => void; onOpenFocus: (focusAreaId: string) => void; order: string[]; changes: FocusChanges }) {
  const { t } = useI18n()
  const name = group.kind === 'area' ? group.area.name : group.kind === 'other' ? t('Other') : t('Sorting…')
  const focusAreaId = group.kind === 'area' ? group.area.id : group.kind === 'other' ? OTHER_FOCUS_AREA_ID : null
  // The owner's order covers kept areas only, all of them at once (the worker refuses anything else).
  const at = group.kind === 'area' ? order.indexOf(group.area.id) : -1
  const move = (to: number) => { const next = [...order]; [next[at], next[to]] = [next[to], next[at]]; void changes.apply({ action: 'reorder', focusAreaIds: next }) }
  return (
    <div className="flex items-center gap-2 border-b px-2 py-2">
      <Button variant="ghost" size="sm" className="size-11 shrink-0 p-0 text-muted-foreground md:size-7" aria-expanded={open} aria-label={interpolate(t(open ? 'Hide the chats in {name}' : 'Show the chats in {name}'), { name })} onClick={onToggle}>
        <ChevronRightIcon className={cn('transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
      </Button>
      <h2 className="min-w-0 flex-1 text-sm font-semibold tracking-tight">
        {focusAreaId ? <button type="button" onClick={() => onOpenFocus(focusAreaId)} title={group.kind === 'area' ? group.area.goal || undefined : undefined} className="rounded-sm text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring">{name}</button> : name}
      </h2>
      <Req ids={['R19.9']}>
        <ul className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground tabular-nums">
          {COUNTED_STATES.map((state) => {
            const count = group.requests.filter((request) => request.state === state).length
            return count > 0 && <li key={state} title={t(STATE_LABEL[state])} className="inline-flex items-center gap-1.5"><span className={cn('size-2 rounded-full', STATE_DOT[state])} />{count}<span className="sr-only"> {t(STATE_LABEL[state])}</span></li>
          })}
        </ul>
      </Req>
      {at >= 0 && (
        <Req ids={['R19.9']}>
          <span className="inline-flex shrink-0">
            <Button variant="ghost" size="sm" className="size-11 p-0 text-muted-foreground md:size-7" aria-label={interpolate(t('Move {name} up'), { name })} disabled={at === 0 || changes.saving} onClick={() => move(at - 1)}><ArrowUpIcon /></Button>
            <Button variant="ghost" size="sm" className="size-11 p-0 text-muted-foreground md:size-7" aria-label={interpolate(t('Move {name} down'), { name })} disabled={at === order.length - 1 || changes.saving} onClick={() => move(at + 1)}><ArrowDownIcon /></Button>
          </span>
        </Req>
      )}
    </div>
  )
}

/**
 * With every request showing, the focus areas come first, in the owner's order: each one a line of counts that opens
 * onto its threads. Inside one area there is nothing to group by, so the rows stand alone.
 */
export function ThreadList({ requests, focusAreas, grouped, onOpen, onOpenFocus }: { requests: Request[]; focusAreas: readonly FocusArea[]; grouped: boolean; onOpen: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void }) {
  const { t } = useI18n()
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const changes = useFocusChanges()
  const order = focusAreas.filter((area) => area.status === 'kept' && !area.mergedInto).sort(byFocusPriority).map((area) => area.id)
  const toggle = (key: string) => setOpened((current) => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next })
  return (
    <Req ids={['R19.1', 'R1.1', 'R2.1', 'R3.3', 'R11.1']}>
      {grouped ? (
        <div>
          {threadGroups(focusAreas, requests).map((group) => (
            <Req key={group.key} ids={['R16.5']}>
              <section>
                <FocusLine group={group} open={opened.has(group.key)} onToggle={() => toggle(group.key)} onOpenFocus={onOpenFocus} order={order} changes={changes} />
                {opened.has(group.key) && (
                  <div className="pt-2 pb-4">
                    {group.kind === 'area' && (
                      <>
                        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-2 pb-2">
                          <div className="min-w-0 flex-1"><FocusNotes area={group.area} changes={changes} /></div>
                          <PlanButton focusAreaId={group.area.id} />
                        </div>
                        <PlanProposals focusAreaId={group.area.id} changes={changes} className="px-2 pb-2" />
                      </>
                    )}
                    {group.requests.length > 0 ? <><ColumnNames /><Rows requests={group.requests} onOpen={onOpen} /></> : <p className="px-2 text-sm text-muted-foreground">{t('Nothing here')}</p>}
                  </div>
                )}
              </section>
            </Req>
          ))}
        </div>
      ) : <><ColumnNames /><Rows requests={sortThreads(requests)} onOpen={onOpen} /></>}
    </Req>
  )
}
