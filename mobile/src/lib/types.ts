// Hand-written minimal API shapes for auth (backend: apps/accounts, apps/telegram_bot).
// TODO: replace with @habi/api-client generated types once the client is generated.

export type Language = 'uz' | 'ru' | 'en';

export interface User {
  id: number | string;
  telegram_id: number | string | null;
  telegram_username: string;
  phone: string;
  first_name: string;
  last_name: string;
  language: Language;
  role: string;
  tg_notifications: boolean;
}

export interface AuthResult {
  access: string;
  refresh: string;
  user: User;
  is_new: boolean;
}

export interface StartLoginResponse {
  login_token: string;
  bot_url: string;
  expires_in: number;
}

export type LoginStatus = 'PENDING' | 'CONFIRMED' | 'EXPIRED';

export interface LoginStatusResponse {
  status: LoginStatus;
  needs_code: boolean;
}

export interface RefreshResponse {
  access: string;
  /** Present when the server rotates refresh tokens (it does). */
  refresh?: string;
}
