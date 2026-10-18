import type { Slot, Zone } from '@habi/api-client'
import { Alert, Button, Card, Popconfirm, Space, Table, Typography, message } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BulkSlotsForm } from '../components/BulkSlotsForm'
import { ParkingSelect } from '../components/ParkingSelect'
import { QueryError } from '../components/QueryError'
import { ZoneForm } from '../components/ZoneForm'
import { adminApi } from '../lib/api'
import { errorText } from '../lib/errorText'
import { fetchAll } from '../lib/fetchAll'
import type { BulkSlotsFormValues, ZoneFormValues } from '../schemas'

export default function ZonesSlotsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [lotId, setLotId] = useState<string | undefined>()
  const [slotPage, setSlotPage] = useState(1)
  const [slotPageSize, setSlotPageSize] = useState(20)

  const zones = useQuery({
    queryKey: ['zones', lotId],
    queryFn: () => fetchAll((p) => adminApi.zones.list({ ...p, parking_lot: lotId })),
    enabled: Boolean(lotId),
  })
  const slots = useQuery({
    queryKey: ['slots', lotId, slotPage, slotPageSize],
    queryFn: () =>
      adminApi.slots.list({ parking_lot: lotId, page: slotPage, page_size: slotPageSize }),
    enabled: Boolean(lotId),
  })

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['zones'] }),
      queryClient.invalidateQueries({ queryKey: ['slots'] }),
      queryClient.invalidateQueries({ queryKey: ['parkings'] }),
    ])
  }
  const onError = (error: unknown) => void message.error(errorText(error, t))

  const addZone = useMutation({
    mutationFn: ({ lot, values }: { lot: string; values: ZoneFormValues }) =>
      adminApi.zones.create({ parking_lot: lot, ...values }),
    onSuccess: refresh,
  })
  const removeZone = useMutation({
    mutationFn: (id: string) => adminApi.zones.remove(id),
    onSuccess: refresh,
    onError,
  })
  const bulk = useMutation({
    mutationFn: (values: BulkSlotsFormValues) => adminApi.slots.bulk(values),
    onSuccess: async (result) => {
      void message.success(t('slots.bulkDone', { count: result.created }))
      await refresh()
    },
  })

  const zoneList: Zone[] = zones.data ?? []

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <Typography.Title level={3} style={{ margin: 0 }}>
        {t('nav.zonesSlots')}
      </Typography.Title>
      <ParkingSelect
        value={lotId}
        onChange={(id) => {
          setLotId(id)
          setSlotPage(1)
        }}
      />
      {lotId ? (
        <>
          <Card title={t('zones.title')}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <ZoneForm
                submitting={addZone.isPending}
                error={addZone.error}
                onSubmit={async (values) => {
                  await addZone.mutateAsync({ lot: lotId, values })
                }}
              />
              {zones.isError ? (
                <QueryError error={zones.error} onRetry={() => void zones.refetch()} />
              ) : null}
              <Table<Zone>
                rowKey="id"
                size="small"
                pagination={false}
                loading={zones.isLoading}
                dataSource={zoneList}
                columns={[
                  { title: t('zones.name'), dataIndex: 'name' },
                  { title: t('zones.floor'), dataIndex: 'floor' },
                  {
                    title: t('common.actions'),
                    render: (_, zone) => (
                      <Popconfirm
                        title={t('common.confirmDelete')}
                        onConfirm={() => removeZone.mutate(zone.id)}
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
          <Card title={t('slots.bulkTitle')}>
            {zoneList.length === 0 ? (
              <Alert type="info" message={t('zones.add')} />
            ) : (
              <BulkSlotsForm
                key={zoneList.map((z) => z.id).join(',')}
                zones={zoneList}
                submitting={bulk.isPending}
                error={bulk.error}
                onSubmit={async (values) => {
                  await bulk.mutateAsync(values)
                }}
              />
            )}
          </Card>
          <Card title={t('slots.title')}>
            {slots.isError ? (
              <QueryError error={slots.error} onRetry={() => void slots.refetch()} />
            ) : null}
            <Table<Slot>
              rowKey="id"
              size="small"
              loading={slots.isLoading}
              dataSource={slots.data?.results ?? []}
              pagination={{
                current: slotPage,
                pageSize: slotPageSize,
                total: slots.data?.count ?? 0,
                showTotal: (total) => t('common.total', { total }),
                onChange: (page, size) => {
                  setSlotPage(page)
                  setSlotPageSize(size)
                },
              }}
              columns={[
                { title: t('slots.code'), dataIndex: 'code' },
                {
                  title: t('slots.type'),
                  dataIndex: 'type',
                  render: (v: Slot['type']) => t(`slots.types.${v}`),
                },
                {
                  title: t('slots.status'),
                  dataIndex: 'status',
                  render: (v: Slot['status']) => t(`slots.statuses.${v}`),
                },
                { title: t('slots.distance'), dataIndex: 'distance_to_entrance' },
              ]}
            />
          </Card>
        </>
      ) : null}
    </Space>
  )
}
