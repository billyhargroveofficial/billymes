import { memo, type ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'

export type ChartTable = {
  head: readonly string[]
  rows: readonly (readonly string[])[]
}

/**
 * Frame every chart shares: the drawing, a visually hidden data table so the
 * numbers are reachable without sight, and an optional visible caption.
 */
export const ChartFigure = memo(function ChartFigure({
  table,
  caption,
  children,
  className,
}: {
  table?: ChartTable
  caption?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <figure className={cn('m-0 min-w-0', className)}>
      {children}
      {table && (
        <div className="sr-only">
          <table>
            <thead>
              <tr>
                {table.head.map((cell) => (
                  <th key={cell} scope="col">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={row[0]}>
                  {row.map((cell, index) => (
                    <td key={`${row[0]}-${table.head[index] ?? index}`}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {caption && <figcaption className="mt-2 text-[11px] text-mute">{caption}</figcaption>}
    </figure>
  )
})
