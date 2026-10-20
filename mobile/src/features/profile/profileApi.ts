import type { AxiosInstance } from 'axios';

import type { Language, User } from '@/lib/types';

type Client = Pick<AxiosInstance, 'patch' | 'delete'>;

/** The account's own data: name, language, deletion. All calls are authenticated by the shared client. */
export function createProfileApi(client: Client) {
  return {
    async updateName(firstName: string): Promise<User> {
      const response = await client.patch<User>('/me', { first_name: firstName.trim() });
      return response.data;
    },
    async updateLanguage(language: Language): Promise<User> {
      const response = await client.patch<User>('/me', { language });
      return response.data;
    },
    /**
     * `DELETE /me` -> 204. 409 `account_deletion_blocked` (active bookings / owned lots) is thrown as the
     * usual axios error: errors.ts maps it to a message. The caller wipes local data only after success.
     */
    async deleteAccount(): Promise<void> {
      await client.delete('/me');
    },
  };
}
