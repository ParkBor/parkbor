import type { Tariff } from '@habi/api-client'
import { Button, Card, Popconfirm, Space, Table, Typography, message } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ParkingSelect } from '../components/ParkingSelect'
import { QueryError } from '../components/QueryError'
import { TariffForm } from '../components/TariffForm'
import { adminApi } from '../lib/api'
import { describeError } from '../lib/errors'
import { fetchAll } from '../lib/fetchAll'
import type { TariffFormValues } from '../schemas'

export default function TariffsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [lotId, setLotId] = useState<string | undefined>()

  const tariffs = useQuery({
    queryKey: ['tariffs', lotId],
    queryFn: () => fetchAll((p) => adminApi.tariffs.list({ ...p, parking_lot: lotId })),
    enabled: Boolean(lotId),
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tariffs'] })
  const onError = (error: unknown) => void message.error(describeError(error, t('common.error')))

  const create = useMutation({
    mutationFn: ({ lot, values }: { lot: string; values: TariffFormValues }) =>
      adminApi.tariffs.create({ parking_lot: lot, ...values }),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: (id: string) => adminApi.tariffs.remove(id),
    onSuccess: refresh,
    onError,
  })

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <Typography.Title level={3} style={{ margin: 0 }}>
        {t('tariffs.title')}
      </Typography.Title>
      <ParkingSelect value={lotId} onChange={setLotId} />
      {lotId ? (
        <Card>
          <Space direction="vertical" style={{ width: '100%' }}>
            <TariffForm
              submitting={create.isPending}
              error={create.error}
              onSubmit={async (values) => {
                await create.mutateAsync({ lot: lotId, values })
              }}
            />
            {tariffs.isError ? (
              <QueryError error={tariffs.error} onRetry={() => void tariffs.refetch()} />
            ) : null}
            <Table<Tariff>
              rowKey="id"
              size="small"
              pagination={false}
              loading={tariffs.isLoading}
              dataSource={tariffs.data ?? []}
              columns={[
                {
                  title: t('tariffs.slotType'),
                  dataIndex: 'slot_type',
                  render: (v: Tariff['slot_type']) => t(`slots.types.${v}`),
                },
                { title: t('tariffs.price'), dataIndex: 'price_per_hour' },
                {
                  title: t('common.actions'),
                  render: (_, tariff) => (
                    <Popconfirm
                      title={t('common.confirmDelete')}
                      onConfirm={() => remove.mutate(tariff.id)}
                    >
                      <Button size="small" danger>
                        {t('common.delete')}
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]}
            />
          </Space>
        </Card>
      ) : null}
    </Space>
  )
}
