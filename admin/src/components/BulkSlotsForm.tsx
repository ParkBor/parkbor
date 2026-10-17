import { zodResolver } from '@hookform/resolvers/zod'
import type { Zone } from '@habi/api-client'
import { Alert, Button, Form, Input, InputNumber, Select } from 'antd'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useServerErrors } from '../lib/formErrors'
import { safeSubmit } from '../lib/safeSubmit'
import { bulkSlotsSchema, PREFIX_RE, type BulkSlotsFormValues } from '../schemas'
import { FormField } from './FormField'

const SLOT_TYPES = ['STANDARD', 'EV', 'DISABLED', 'LARGE'] as const
const FIELD_MAP = {
  zone: 'zone',
  prefix: 'prefix',
  start: 'start',
  end: 'end',
  type: 'type',
  distance_to_entrance: 'distance_to_entrance',
} as const

interface BulkSlotsFormProps {
  zones: Zone[]
  submitting?: boolean
  error?: unknown
  onSubmit: (values: BulkSlotsFormValues) => void | Promise<void>
}

/** The zone name is only a sensible prefix when the backend would accept it. */
function defaultsFor(zones: Zone[]): BulkSlotsFormValues {
  const first = zones[0]
  return {
    zone: first?.id ?? '',
    prefix: first && PREFIX_RE.test(first.name) ? first.name : '',
    start: 1,
    end: 50,
    type: 'STANDARD',
    distance_to_entrance: 0,
  }
}

/** "Zone A, 1-50": creates slots A-1..A-50 in one request. */
export function BulkSlotsForm({ zones, submitting, error, onSubmit }: BulkSlotsFormProps) {
  const { t } = useTranslation()
  const defaults = defaultsFor(zones)
  const { control, handleSubmit, reset, setError, formState } = useForm<BulkSlotsFormValues>({
    resolver: zodResolver(bulkSlotsSchema),
    defaultValues: defaults,
  })
  const general = useServerErrors(error, setError, FIELD_MAP)

  return (
    <Form
      layout="inline"
      aria-label={t('forms.bulkSlots')}
      onFinish={handleSubmit((values) =>
        safeSubmit(formState.isSubmitting, onSubmit, values, () => reset(defaults)),
      )}
    >
      {general ? <Alert type="error" message={general} style={{ marginBottom: 8 }} /> : null}
      <FormField
        control={control}
        name="zone"
        label={t('slots.zone')}
        render={({ value, onChange, id }) => (
          <Select
            id={id}
            style={{ minWidth: 120 }}
            value={value}
            onChange={onChange}
            options={zones.map((z) => ({ value: z.id, label: z.name }))}
          />
        )}
      />
      <FormField
        control={control}
        name="prefix"
        label={t('slots.prefix')}
        render={({ value, onChange, id }) => (
          <Input id={id} value={value} onChange={onChange} style={{ width: 90 }} />
        )}
      />
      <FormField
        control={control}
        name="start"
        label={t('slots.start')}
        render={({ value, onChange, id }) => (
          <InputNumber id={id} value={value} onChange={onChange} />
        )}
      />
      <FormField
        control={control}
        name="end"
        label={t('slots.end')}
        render={({ value, onChange, id }) => (
          <InputNumber id={id} value={value} onChange={onChange} />
        )}
      />
      <FormField
        control={control}
        name="type"
        label={t('slots.type')}
        render={({ value, onChange, id }) => (
          <Select
            id={id}
            style={{ minWidth: 150 }}
            value={value}
            onChange={onChange}
            options={SLOT_TYPES.map((v) => ({ value: v, label: t(`slots.types.${v}`) }))}
          />
        )}
      />
      <FormField
        control={control}
        name="distance_to_entrance"
        label={t('slots.distance')}
        render={({ value, onChange, id }) => (
          <InputNumber id={id} value={value} onChange={onChange} min={0} />
        )}
      />
      <Button type="primary" htmlType="submit" loading={submitting || formState.isSubmitting}>
        {t('slots.bulkSubmit')}
      </Button>
    </Form>
  )
}
