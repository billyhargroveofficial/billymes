import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Options } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'

/**
 * Math is parsed from `$…$` / `$$…$$` and rendered by KaTeX. Both the parser
 * and the KaTeX runtime ride this lazily loaded chunk, so a session that never
 * shows Markdown never pays for them.
 */
const REMARK_PLUGINS: Options['remarkPlugins'] = [remarkGfm, remarkMath]
const REHYPE_PLUGINS: Options['rehypePlugins'] = [
  [rehypeKatex, { throwOnError: false, strict: false }],
]

/**
 * Fenced code blocks get a hover copy control. The text is read back from the
 * rendered DOM node, so it works for any nesting the markdown produces.
 */
function PreBlock({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement | null>(null)
  const timer = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    [],
  )
  return (
    <div className="group/pre relative">
      <pre ref={preRef}>{children}</pre>
      <button
        type="button"
        aria-label="скопировать код"
        title="скопировать код"
        onClick={() => {
          const text = preRef.current?.innerText ?? ''
          if (text) void navigator.clipboard?.writeText(text).catch(() => undefined)
          setCopied(true)
          if (timer.current) window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setCopied(false), 1300)
        }}
        className="absolute right-2 top-2 grid size-7 place-items-center rounded-lg border border-line/70 bg-panel/90 text-mute opacity-0 backdrop-blur transition-opacity duration-150 hover:text-paper focus-visible:opacity-100 group-hover/pre:opacity-100 pointer-coarse:opacity-100"
      >
        {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  )
}

const COMPONENTS: Options['components'] = { pre: PreBlock }

export default function MarkdownRenderer({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
