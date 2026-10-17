import { zodResolver } from '@hookform/resolvers/zod'
import { Alert, Button, Form, Input, Select } from 'antd'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useServerErrors } from '../lib/formErrors'
import { safeSubmit } from '../lib/safeSubmit'
import { tariffSchema, type TariffFormValues } from '../schemas'
import { FormField } from './FormField'

const SLOT_TYPES = ['STANDARD', 'EV', 'DISABLED', 'LARGE'] as const
const DEFAULTS: TariffFormValues = { slot_type: 'STANDARD', price_per_hour: '' }
const FIELD_MAP = { slot_type: 'slot_type', price_per_hour: 'price_per_hour' } as const

interface TariffFormProps {
  submitting?: boolean
  error?: unknown
  onSubmit: (values: TariffFormValues) => void | Promise<void>
}

export function TariffForm({ submitting, error, onSubmit }: TariffFormProps) {
  const { t } = useTranslation()
  const { control, handleSubmit, reset, setError, formState } = useForm<TariffFormValues>({
    resolver: zodResolver(tariffSchema),
    defaultValues: DEFAULTS,
  })
  const general = useServerErrors(error, setError, FIELD_MAP)

  return (
    <Form
      layout="inline"
      aria-label={t('forms.tariff')}
      onFinish={handleSubmit((values) =>
        safeSubmit(formState.isSubmitting, onSubmit, values, () => reset(DEFAULTS)),
      )}
    >
      {general ? <Alert type="error" message={general} style={{ marginBottom: 8 }} /> : null}
      <FormField
        control={control}
        name="slot_type"
        label={t('tariffs.slotType')}
        render={({ value, onChange, id }) => (
          <Select
            id={id}
            style={{ minWidth: 160 }}
            value={value}
            onChange={onChange}
            options={SLOT_TYPES.map((v) => ({ value: v, label: t(`slots.types.${v}`) }))}
          />
        )}
      />
      <FormField
        control={control}
        name="price_per_hour"
        label={t('tariffs.price')}
        render={({ value, onChange, id }) => (
          <Input id={id} value={value} onChange={onChange} inputMode="decimal" />
        )}
      />
      <Button type="primary" htmlType="submit" loading={submitting || formState.isSubmitting}>
        {t('tariffs.add')}
      </Button>
    </Form>
  )
}
