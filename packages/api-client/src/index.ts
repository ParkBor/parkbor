// TEMPORARY hand-written client.
// The real client is generated from the backend OpenAPI schema with orval
// (`pnpm --filter @habi/api-client generate`, see CLAUDE.md). Until orval is wired in, this thin
// fetch client covers the admin and auth endpoints. Replace these exports with the generated
// ones; keep the exported names stable so the apps need no changes.
export * from './admin'
export * from './adminOps'
export * from './auth'
export {
  ApiError,
  buildQuery,
  createHttpClient,
  DEFAULT_TIMEOUT_MS,
  isAuthEndpoint,
} from './http'
export type {
  ApiErrorKind,
  HttpClient,
  HttpClientOptions,
  RefreshOutcome,
  RequestOptions,
  TokenProvider,
} from './http'
