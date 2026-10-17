import { useRouter } from 'expo-router';
import type { Dispatch, SetStateAction } from 'react';

import type { CreateBookingPayload } from '@/features/booking/idempotencyKey';
import { useCreateBooking } from '@/features/booking/useCreateBooking';
import { learnFromBookingFailure, learnServerDefault, type ProviderChoice } from '@/features/payment/providerChoice';

/**
 * "Pay and book": creates the booking, teaches the provider picker from the answer (a refused
 * provider disappears, a default-made booking reveals the server default) and moves to the payment
 * screen - or to the detail when a replay shows the booking is no longer waiting for payment.
 */
export function useBookingSubmit(payload: CreateBookingPayload | null, setProviders: Dispatch<SetStateAction<ProviderChoice>>) {
  const router = useRouter();
  const create = useCreateBooking();

  const submit = async (): Promise<void> => {
    if (!payload) return;
    const sent = payload.paymentProvider;
    const result = await create.submit(payload, (failure) =>
      setProviders((current) => learnFromBookingFailure(current, failure, sent)),
    );
    if (!result) return;
    setProviders((current) => learnServerDefault(current, result.booking.paymentProvider, sent === null));
    // A replay of an earlier success may already be paid: let the detail screen show the truth.
    const isPending = result.booking.status === 'PENDING_PAYMENT';
    router.replace({ pathname: isPending ? '/booking/pay' : '/booking/[id]', params: { id: result.booking.id } });
  };

  return { create, submit };
}
