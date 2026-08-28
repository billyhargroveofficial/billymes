import { lazy, Suspense } from 'react'

const markdownRenderer = lazy(() => import('./MarkdownRenderer'))

/** Shared renderer for trusted agent and skill Markdown. */
export function Markdown({ text }: { text: string }) {
  if (!text) return null
  const Renderer = markdownRenderer
  return (
    <Suspense fallback={null}>
      <Renderer text={text} />
    </Suspense>
  )
}
