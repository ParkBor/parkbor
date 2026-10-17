import { zodResolver } from '@hookform/resolvers/zod'
import { Alert, Button, Form, Input, InputNumber } from 'antd'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useServerErrors } from '../lib/formErrors'
import { safeSubmit } from '../lib/safeSubmit'
import { zoneSchema, type ZoneFormValues } from '../schemas'
import { FormField } from './FormField'

interface ZoneFormProps {
  submitting?: boolean
  error?: unknown
  onSubmit: (values: ZoneFormValues) => void | Promise<void>
}

const DEFAULTS: ZoneFormValues = { name: '', floor: 0 }
const FIELD_MAP = { name: 'name', floor: 'floor' } as const

export function ZoneForm({ submitting, error, onSubmit }: ZoneFormProps) {
  const { t } = useTranslation()
  const { control, handleSubmit, reset, setError, formState } = useForm<ZoneFormValues>({
    resolver: zodResolver(zoneSchema),
    defaultValues: DEFAULTS,
  })
  const general = useServerErrors(error, setError, FIELD_MAP)

  return (
    <Form
      layout="inline"
      aria-label={t('forms.zone')}
      onFinish={handleSubmit((values) =>
        safeSubmit(formState.isSubmitting, onSubmit, values, () => reset(DEFAULTS)),
      )}
    >
      {general ? <Alert type="error" message={general} style={{ marginBottom: 8 }} /> : null}
      <FormField
        control={control}
        name="name"
        label={t('zones.name')}
        render={({ value, onChange, id }) => (
          <Input id={id} value={value} onChange={onChange} />
        )}
      />
      <FormField
        control={control}
        name="floor"
        label={t('zones.floor')}
        render={({ value, onChange, id }) => (
          <InputNumber id={id} value={value} onChange={onChange} />
        )}
      />
      <Button
        type="primary"
        htmlType="submit"
        loading={submitting || formState.isSubmitting}
      >
        {t('zones.add')}
      </Button>
    </Form>
  )
}
