import { Button, Space, Spin, Typography, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ParkingForm } from '../components/ParkingForm'
import { QueryError } from '../components/QueryError'
import { adminApi } from '../lib/api'
import { useRole } from '../lib/auth'
import { toPayload } from '../lib/payload'
import type { ParkingFormValues } from '../schemas'

export default function ParkingEditPage() {
  const { t } = useTranslation()
  const { id } = useParams()
  const navigate = useNavigate()
  const role = useRole()
  const queryClient = useQueryClient()
  const isEdit = Boolean(id)

  const existing = useQuery({
    queryKey: ['parkings', id],
    queryFn: () => adminApi.parkings.get(id ?? ''),
    enabled: isEdit,
  })

  const save = useMutation({
    mutationFn: (values: ParkingFormValues) =>
      id
        ? adminApi.parkings.update(id, toPayload(values))
        : adminApi.parkings.create(toPayload(values)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['parkings'] })
      void message.success(t('common.saved'))
      navigate('/parkings')
    },
  })

  if (isEdit && existing.isLoading) return <Spin />
  if (isEdit && existing.isError) {
    // Never fall through to an empty "new lot" form when loading the lot failed.
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        <QueryError error={existing.error} onRetry={() => void existing.refetch()} />
        <Button onClick={() => navigate('/parkings')}>{t('common.back')}</Button>
      </Space>
    )
  }

  const lot = existing.data
  return (
    <>
      <Typography.Title level={3}>
        {isEdit ? t('parkings.editTitle') : t('parkings.new')}
      </Typography.Title>
      <ParkingForm
        // Remount when the loaded lot changes so defaultValues apply.
        key={lot?.id ?? 'new'}
        initialValues={
          lot
            ? {
                name: lot.name,
                address: lot.address,
                lat: lot.location.lat,
                lng: lot.location.lng,
                open_time: lot.open_time?.slice(0, 5) ?? '',
                close_time: lot.close_time?.slice(0, 5) ?? '',
              }
            : undefined
        }
        requireOwner={!isEdit && role === 'ADMIN'}
        submitting={save.isPending}
        error={save.error}
        onSubmit={async (values) => {
          await save.mutateAsync(values)
        }}
        onCancel={() => navigate('/parkings')}
      />
    </>
  )
}
