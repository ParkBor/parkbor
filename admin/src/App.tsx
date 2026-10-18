import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PageSpinner } from './components/PageSpinner'
import { ProtectedRoute } from './components/ProtectedRoute'
import { RequireFeature } from './components/RequireFeature'

// Every page is lazy: Leaflet, the Excel writer and the tables load only when needed.
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const ParkingsListPage = lazy(() => import('./pages/ParkingsListPage'))
const ParkingEditPage = lazy(() => import('./pages/ParkingEditPage'))
const ZonesSlotsPage = lazy(() => import('./pages/ZonesSlotsPage'))
const TariffsPage = lazy(() => import('./pages/TariffsPage'))
const BookingsPage = lazy(() => import('./pages/BookingsPage'))
const BookingDetailPage = lazy(() => import('./pages/BookingDetailPage'))
const OverstayPage = lazy(() => import('./pages/OverstayPage'))
const PaymentsPage = lazy(() => import('./pages/PaymentsPage'))
const RefundsPage = lazy(() => import('./pages/RefundsPage'))
const OperatorsPage = lazy(() => import('./pages/OperatorsPage'))
const UsersPage = lazy(() => import('./pages/UsersPage'))
const ModerationPage = lazy(() => import('./pages/ModerationPage'))
const ReviewsPage = lazy(() => import('./pages/ReviewsPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const AuditLogPage = lazy(() => import('./pages/AuditLogPage'))
const LoginPage = lazy(() => import('./pages/LoginPage'))

export default function App() {
  const { pathname } = useLocation()
  return (
    <ErrorBoundary resetKey={pathname}>
      <Suspense fallback={<PageSpinner />}>
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route element={<RequireFeature feature="dashboard" />}>
              <Route path="dashboard" element={<DashboardPage />} />
            </Route>
            <Route element={<RequireFeature feature="parkings" />}>
              <Route path="parkings" element={<ParkingsListPage />} />
              <Route path="parkings/new" element={<ParkingEditPage />} />
              <Route path="parkings/:id/edit" element={<ParkingEditPage />} />
            </Route>
            <Route element={<RequireFeature feature="zonesSlots" />}>
              <Route path="zones-slots" element={<ZonesSlotsPage />} />
            </Route>
            <Route element={<RequireFeature feature="tariffs" />}>
              <Route path="tariffs" element={<TariffsPage />} />
            </Route>
            <Route element={<RequireFeature feature="bookings" />}>
              <Route path="bookings" element={<BookingsPage />} />
              <Route path="bookings/:id" element={<BookingDetailPage />} />
            </Route>
            <Route element={<RequireFeature feature="overstay" />}>
              <Route path="overstay" element={<OverstayPage />} />
            </Route>
            <Route element={<RequireFeature feature="payments" />}>
              <Route path="payments" element={<PaymentsPage />} />
              <Route path="refunds" element={<RefundsPage />} />
            </Route>
            <Route element={<RequireFeature feature="operators" />}>
              <Route path="operators" element={<OperatorsPage />} />
            </Route>
            <Route element={<RequireFeature feature="users" />}>
              <Route path="users" element={<UsersPage />} />
            </Route>
            <Route element={<RequireFeature feature="moderation" />}>
              <Route path="moderation" element={<ModerationPage />} />
            </Route>
            <Route element={<RequireFeature feature="reviews" />}>
              <Route path="reviews" element={<ReviewsPage />} />
            </Route>
            <Route element={<RequireFeature feature="settings" />}>
              <Route path="settings" element={<SettingsPage />} />
            </Route>
            <Route element={<RequireFeature feature="audit" />}>
              <Route path="audit" element={<AuditLogPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Route>
      </Routes>
      </Suspense>
    </ErrorBoundary>
  )
}
