import type { AdminSettings } from '@habi/api-client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Form, InputNumber, Space, Typography, message } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListError } from '../components/ListError'
import { adminApi } from '../lib/api'
import { errorText } from '../lib/errorText'
import { SETTINGS_FIELDS, settingsErrors } from '../lib/settingsSchema'

type FieldErrors = Partial<Record<keyof AdminSettings, string>>

/** Booking settings: hold time, no-show grace, cancellation policy (ADMIN only). */
export default function SettingsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [form] = Form.useForm<AdminSettings>()
  const [errors, setErrors] = useState<FieldErrors>({})
  const query = useQuery({ queryKey: ['settings'], queryFn: () => adminApi.settings.get() })
  const save = useMutation({
    mutationFn: (values: AdminSettings) => adminApi.settings.update(values),
    onSuccess: (saved) => {
      void message.success(t('common.saved'))
      queryClient.setQueryData(['settings'], saved)
    },
    onError: (error) => void message.error(errorText(error, t)),
  })

  useEffect(() => {
    if (query.data) form.setFieldsValue(query.data)
  }, [query.data, form])

  function submit(values: AdminSettings) {
    const found = settingsErrors(values)
    setErrors(found)
    if (Object.keys(found).length === 0) save.mutate(values)
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Typography.Title level={3} style={{ margin: 0 }}>
        {t('settings.title')}
      </Typography.Title>
      {query.isError ? <ListError error={query.error} onRetry={() => void query.refetch()} /> : null}
      <Form<AdminSettings>
        form={form}
        layout="vertical"
        style={{ maxWidth: 420 }}
        aria-label={t('settings.title')}
        onFinish={submit}
        disabled={!query.data}
      >
        {SETTINGS_FIELDS.map((field) => (
          <Form.Item
            key={field}
            name={field}
            label={t(`settings.fields.${field}`)}
            validateStatus={errors[field] ? 'error' : undefined}
            help={errors[field] ? t(errors[field]) : undefined}
          >
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
        ))}
        <Button type="primary" htmlType="submit" loading={save.isPending}>
          {t('common.save')}
        </Button>
      </Form>
    </Space>
  )
}
