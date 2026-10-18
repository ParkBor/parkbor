import { usePushSetup } from '@/features/push/usePushSetup';

/** Renders nothing; mounts the push wiring inside the query/i18n providers. */
export function PushSetup(): null {
  usePushSetup();
  return null;
}
