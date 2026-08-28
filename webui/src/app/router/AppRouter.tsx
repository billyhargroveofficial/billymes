import { Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/app/shell/AppShell'
import { SkeletonPage } from '@/shared/ui/skeleton'
import { APP_ROUTES } from './route-registry'

export function AppRouter() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        {APP_ROUTES.map((route) => {
          const Page = route.page
          const element = (
            <Suspense fallback={<SkeletonPage label={`загружаем «${route.label}»`} />}>
              <Page />
            </Suspense>
          )
          return route.path === '/' ? (
            <Route key={route.path} index element={element} />
          ) : (
            <Route key={route.path} path={route.path.slice(1)} element={element} />
          )
        })}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
