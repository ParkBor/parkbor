import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { ProtectedRoute } from './components/ProtectedRoute'

// Pages are lazy so the Leaflet-heavy form is only loaded when needed.
const ParkingsListPage = lazy(() => import('./pages/ParkingsListPage'))
const ParkingEditPage = lazy(() => import('./pages/ParkingEditPage'))
const ZonesSlotsPage = lazy(() => import('./pages/ZonesSlotsPage'))
const TariffsPage = lazy(() => import('./pages/TariffsPage'))
const LoginPage = lazy(() => import('./pages/LoginPage'))

export default function App() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route index element={<Navigate to="/parkings" replace />} />
            <Route path="parkings" element={<ParkingsListPage />} />
            <Route path="parkings/new" element={<ParkingEditPage />} />
            <Route path="parkings/:id/edit" element={<ParkingEditPage />} />
            <Route path="zones-slots" element={<ZonesSlotsPage />} />
            <Route path="tariffs" element={<TariffsPage />} />
            <Route path="*" element={<Navigate to="/parkings" replace />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  )
}
