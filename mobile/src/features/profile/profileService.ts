import { createProfileApi } from '@/features/profile/profileApi';
import { api } from '@/lib/api';

/** The profile calls on the app's authenticated client. */
export const profileApi = createProfileApi(api);
