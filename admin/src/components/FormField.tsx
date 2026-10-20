import { Form } from 'antd'
import { useId, type ReactElement } from 'react'
import {
  Controller,
  type Control,
  type FieldValues,
  type Path,
  type PathValue,
} from 'react-hook-form'
import { useTranslation } from 'react-i18next'

interface RenderProps<T extends FieldValues, N extends Path<T>> {
  /** Typed value of exactly this field. */
  value: PathValue<T, N>
  /** react-hook-form accepts any value/event here, so this is deliberately `unknown`. */
  onChange: (value: unknown) => void
  name: N
  /** Put this on the control so the <label> is associated with it (a11y). */
  id: string
}

interface FormFieldProps<T extends FieldValues, N extends Path<T>> {
  control: Control<T>
  name: N
  label: string
  /** Helper text under the input. */
  extra?: string
  render: (props: RenderProps<T, N>) => ReactElement
}

/** Ant Design Form.Item bound to React Hook Form. Messages are i18n keys or raw server text. */
export function FormField<T extends FieldValues, N extends Path<T>>({
  control,
  name,
  label,
  extra,
  render,
}: FormFieldProps<T, N>) {
  const { t, i18n } = useTranslation()
  const id = useId()
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => {
        const message = fieldState.error?.message
        return (
          <Form.Item
            label={label}
            htmlFor={id}
            extra={extra}
            validateStatus={fieldState.error ? 'error' : undefined}
            help={message ? (i18n.exists(message) ? t(message) : message) : undefined}
          >
            {render({
              value: field.value as PathValue<T, N>,
              onChange: field.onChange as (value: unknown) => void,
              name,
              id,
            })}
          </Form.Item>
        )
      }}
    />
  )
}
