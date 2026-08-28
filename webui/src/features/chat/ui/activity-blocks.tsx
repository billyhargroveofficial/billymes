import {
  Check,
  ChevronDown,
  Cpu,
  FileText,
  Globe,
  Lightbulb,
  ListTodo,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'
import { Badge } from '@/shared/ui/badge'
import { Spinner } from '@/shared/ui/spinner'
import { fmtDuration, shortToolName, toolPreview } from '../model/tool-display'
import type { Subagent, TodoItem, ToolCall } from '../model/types'

/** Icon by tool intent — the glyph carries the row, so no boxes are needed. */
function pickToolIcon(name: string): LucideIcon {
  const flat = name.toLowerCase()
  if (flat.startsWith('mcp__')) return Plug
  if (/(terminal|bash|shell|exec|command)/.test(flat)) return SquareTerminal
  if (/(search|grep|find|glob)/.test(flat)) return Search
  if (/(browse|web|fetch|http|url|crawl)/.test(flat)) return Globe
  if (/(read|write|edit|file|path|dir|ls)/.test(flat)) return FileText
  return Wrench
}

function toolGlyph(name: string, failed: boolean) {
  const Icon = pickToolIcon(name)
  return <Icon aria-hidden="true" className={cn('size-3.5', failed ? 'text-ember' : 'text-mute')} />
}

/**
 * A single timeline node: icon column with a hairline connector down to the
 * next node, label content on the right. The trace reads as a quiet log of
 * what happened, not as a stack of framed widgets.
 */
function TraceNode({
  icon,
  last,
  children,
}: {
  icon: ReactNode
  last: boolean
  children: ReactNode
}) {
  return (
    <div className="flex gap-2.5">
      <div className="flex w-4 shrink-0 flex-col items-center">
        <span className="grid h-6 shrink-0 place-items-center">{icon}</span>
        {!last && <span aria-hidden="true" className="w-px flex-1 bg-line" />}
      </div>
      <div className={cn('min-w-0 flex-1', !last && 'pb-1.5')}>{children}</div>
    </div>
  )
}

function ThinkingNode({ text, live, last }: { text: string; live?: boolean; last: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <TraceNode
      last={last && !open}
      icon={
        <Lightbulb
          className={cn('size-3.5', live ? 'pulse-soft text-mercury' : 'text-mute')}
          aria-hidden="true"
        />
      }
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="group/think flex h-6 w-full items-center gap-2 text-left"
      >
        <span
          className={cn(
            'text-[12px] transition-colors',
            live ? 'pulse-soft text-mercury' : 'text-mute group-hover/think:text-paper',
          )}
        >
          {live ? 'думает' : 'мышление'}
        </span>
        {live && <span className="thinking-shimmer h-px w-10" />}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3 text-mute/70 opacity-0 transition-[transform,opacity] duration-200 group-hover/think:opacity-100',
            open && 'rotate-180 opacity-100',
          )}
        />
      </button>
      {open && (
        <pre className="my-1 max-h-44 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-4 text-mute">
          {text || '…'}
        </pre>
      )}
    </TraceNode>
  )
}

/**
 * Thinking, tool calls, and subagents in one connected timeline — a quiet log
 * of the turn in the reference style: icon column, hairline connectors, no
 * boxes. Nodes expand in place for args and results.
 */
export function ActivityTimeline({
  thinking,
  thinkingLive = false,
  tools,
  subagents,
}: {
  thinking: string
  thinkingLive?: boolean
  tools: ToolCall[]
  subagents: Subagent[]
}) {
  const hasThinking = Boolean(thinking) || thinkingLive
  if (!hasThinking && !tools.length && !subagents.length) return null
  const lead = hasThinking ? 1 : 0
  const lastIndex = lead + tools.length + subagents.length - 1
  return (
    <div>
      {hasThinking && <ThinkingNode text={thinking} live={thinkingLive} last={lastIndex === 0} />}
      {tools.map((tool, index) => (
        <ToolRow key={tool.id} tool={tool} last={lead + index === lastIndex} />
      ))}
      {subagents.map((agent, index) => (
        <SubagentNode
          key={agent.id}
          agent={agent}
          last={lead + tools.length + index === lastIndex}
        />
      ))}
    </div>
  )
}

function ToolRow({ tool, last }: { tool: ToolCall; last: boolean }) {
  const [open, setOpen] = useState(false)
  const preview = tool.preview || toolPreview(tool.name, tool.args)
  const running = tool.status === 'running'
  const failed = tool.status === 'error'
  const duration = fmtDuration(tool.duration)

  return (
    <TraceNode
      last={last && !open}
      icon={running ? <Spinner className="text-mercury" /> : toolGlyph(tool.name, failed)}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="group/tool flex h-6 w-full items-center gap-2 text-left"
      >
        <span
          className={cn(
            'shrink-0 text-[12px] transition-colors',
            failed
              ? 'text-ember'
              : running
                ? 'pulse-soft text-mercury'
                : 'text-paper/70 group-hover/tool:text-paper',
          )}
        >
          {shortToolName(tool.name)}
        </span>
        {preview && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-mute/80">
            {preview}
          </span>
        )}
        {duration && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-mute/60">
            {duration}
          </span>
        )}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3 shrink-0 text-mute/70 opacity-0 transition-[transform,opacity] duration-200 group-hover/tool:opacity-100',
            open && 'rotate-180 opacity-100',
          )}
        />
      </button>
      {open && (
        <div className="my-1 space-y-2 font-mono text-[10px] leading-4 text-mute">
          {tool.args && (
            <div>
              <div className="mb-0.5 text-[9px] uppercase tracking-[0.16em] text-mute/70">
                запрос
              </div>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-mercury/80">
                {tool.args}
              </pre>
            </div>
          )}
          {tool.result && (
            <div>
              <div className="mb-0.5 text-[9px] uppercase tracking-[0.16em] text-mute/70">
                ответ
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap">{tool.result}</pre>
            </div>
          )}
          {!tool.args && !tool.result && <p>нет вывода</p>}
        </div>
      )}
    </TraceNode>
  )
}

export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  if (!todos.length) return null
  const done = todos.filter((todo) => todo.status === 'completed').length
  return (
    <div className="rounded-xl border border-mercury/20 bg-mercury/5 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-mercury">
        <ListTodo className="size-3" /> туду
        <span className="ml-auto font-mono normal-case tabular-nums tracking-normal text-mute">
          {done}/{todos.length}
        </span>
        <span className="h-1 w-14 overflow-hidden rounded-full bg-line/60">
          <span
            className="block h-full rounded-full bg-mercury/70 transition-[width] duration-500"
            style={{ width: `${todos.length ? Math.round((done / todos.length) * 100) : 0}%` }}
          />
        </span>
      </div>
      <ul className="space-y-1">
        {todos.map((todo, index) => (
          <li key={`${todo.id}:${index}`} className="flex items-start gap-1.5 text-xs leading-5">
            {todo.status === 'completed' ? (
              <Check className="mt-1 size-3 shrink-0 text-ok" />
            ) : todo.status === 'in_progress' ? (
              <Spinner className="mt-1 size-3 border text-ember" />
            ) : (
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full border border-mute" />
            )}
            <span
              className={cn(
                'transition-colors duration-300',
                todo.status === 'completed' && 'text-mute line-through',
              )}
            >
              {todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SubagentNode({ agent, last }: { agent: Subagent; last: boolean }) {
  const live = agent.status === 'running' || agent.status === 'active'
  return (
    <TraceNode
      last={last}
      icon={
        <Cpu
          aria-hidden="true"
          className={cn('size-3.5', live ? 'pulse-soft text-mercury' : 'text-mute')}
        />
      }
    >
      <div className="flex h-6 items-center gap-2 text-[12px]">
        <span className="min-w-0 truncate text-paper/70">{agent.title}</span>
        <Badge className="ml-auto shrink-0">{agent.status}</Badge>
      </div>
    </TraceNode>
  )
}
