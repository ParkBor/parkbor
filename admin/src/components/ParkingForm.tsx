import { zodResolver } from '@hookform/resolvers/zod'
import { Alert, Button, Form, Input, InputNumber, Space } from 'antd'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useServerErrors } from '../lib/formErrors'
import { useAddressAutofill } from '../lib/useAddressAutofill'
import { safeSubmit } from '../lib/safeSubmit'
import { parkingSchema, type ParkingFormValues } from '../schemas'
import { FormField } from './FormField'
import { MapPicker } from './MapPicker'

interface ParkingFormProps {
  initialValues?: Partial<ParkingFormValues>
  submitting?: boolean
  /** ADMIN creating a lot may name another owner (optional: empty = the admin owns the lot). */
  showOwner?: boolean
  /** Failed save (ApiError): messages are bound to the matching fields. */
  error?: unknown
  onSubmit: (values: ParkingFormValues) => void | Promise<void>
  onCancel?: () => void
}

const EMPTY: Partial<ParkingFormValues> = { name: '', address: '', open_time: '', close_time: '' }
// Backend field -> form field (the backend has one `location`, the form has two inputs).
const FIELD_MAP = {
  name: 'name',
  address: 'address',
  owner: 'owner',
  open_time: 'open_time',
  close_time: 'close_time',
  lat: 'lat',
  lng: 'lng',
  location: 'lat',
} as const

export function ParkingForm({
  initialValues,
  submitting,
  showOwner,
  error,
  onSubmit,
  onCancel,
}: ParkingFormProps) {
  const { t, i18n } = useTranslation()
  const { control, handleSubmit, setValue, setError, getValues, formState } = useForm<ParkingFormValues>({
    resolver: zodResolver(parkingSchema),
    defaultValues: { ...EMPTY, ...initialValues },
  })
  const general = useServerErrors(error, setError, FIELD_MAP)
  const lat = useWatch({ control, name: 'lat' })
  const lng = useWatch({ control, name: 'lng' })
  const hasPoint = typeof lat === 'number' && typeof lng === 'number'

  const fillAddress = useAddressAutofill({
    language: i18n.language,
    getAddress: () => getValues('address') ?? '',
    setAddress: (address) => setValue('address', address, { shouldValidate: true, shouldDirty: true }),
  })

  const submit = handleSubmit((values) => {
    return safeSubmit(formState.isSubmitting, onSubmit, values, () => undefined)
  })

  return (
    <Form layout="vertical" onFinish={submit} aria-label={t('forms.parking')}>
      {general ? <Alert type="error" message={general} style={{ marginBottom: 16 }} /> : null}
      <FormField
        control={control}
        name="name"
        label={t('parkings.name')}
        render={({ value, onChange, id }) => <Input id={id} value={value} onChange={onChange} />}
      />
      {showOwner ? (
        <FormField
          control={control}
          name="owner"
          label={t('parkings.owner')}
          extra={t('parkings.ownerHint')}
          render={({ value, onChange, id }) => (
            <Input id={id} value={value ?? ''} onChange={onChange} />
          )}
        />
      ) : null}
      <FormField
        control={control}
        name="address"
        label={t('parkings.address')}
        render={({ value, onChange, id }) => <Input id={id} value={value} onChange={onChange} />}
      />
      <Form.Item label={t('parkings.location')} extra={t('parkings.mapHint')}>
        <MapPicker
          value={hasPoint ? { lat, lng } : null}
          onChange={(point) => {
            setValue('lat', point.lat, { shouldValidate: true, shouldDirty: true })
            setValue('lng', point.lng, { shouldValidate: true, shouldDirty: true })
            fillAddress(point.lat, point.lng)
          }}
        />
      </Form.Item>
      <Space align="start" wrap>
        <FormField
          control={control}
          name="lat"
          label={t('parkings.lat')}
          render={({ value, onChange, id }) => (
            <InputNumber id={id} value={value} onChange={onChange} step={0.0001} />
          )}
        />
        <FormField
          control={control}
          name="lng"
          label={t('parkings.lng')}
          render={({ value, onChange, id }) => (
            <InputNumber id={id} value={value} onChange={onChange} step={0.0001} />
          )}
        />
        <FormField
          control={control}
          name="open_time"
          label={t('parkings.openTime')}
          render={({ value, onChange, id }) => (
            <Input id={id} value={value} onChange={onChange} placeholder="08:00" />
          )}
        />
        <FormField
          control={control}
          name="close_time"
          label={t('parkings.closeTime')}
          render={({ value, onChange, id }) => (
            <Input id={id} value={value} onChange={onChange} placeholder="22:00" />
          )}
        />
      </Space>
      <Space>
        <Button type="primary" htmlType="submit" loading={submitting || formState.isSubmitting}>
          {t('common.save')}
        </Button>
        {onCancel ? <Button onClick={onCancel}>{t('common.cancel')}</Button> : null}
      </Space>
    </Form>
  )
}
