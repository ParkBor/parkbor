import { z } from 'zod';

/** Backend User.first_name max_length. */
export const NAME_MAX_LENGTH = 150;
const NAME_MIN_LENGTH = 2;
// Letters (any script), combining marks, spaces and common apostrophes/hyphens; no digits/control chars.
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\s'’ʻʼ`.-]*$/u;

export const profileSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(NAME_MIN_LENGTH, 'validation.nameTooShort')
    .max(NAME_MAX_LENGTH, 'validation.nameTooLong')
    .regex(NAME_PATTERN, 'validation.nameInvalid'),
});

export type ProfileForm = z.infer<typeof profileSchema>;
