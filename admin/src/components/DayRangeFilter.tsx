import { DatePicker } from 'antd'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { DayRange } from '../lib/time'

interface DayRangeFilterProps {
  value: DayRange
  onChange: (range: DayRange) => void
}

const DAY_FORMAT = 'YYYY-MM-DD'

/** Picks calendar days (interpreted as Asia/Tashkent days by lib/time). */
export function DayRangeFilter({ value, onChange }: DayRangeFilterProps) {
  const { t } = useTranslation()
  return (
    <DatePicker.RangePicker
      allowClear
      aria-label={t('common.period')}
      format={DAY_FORMAT}
      value={value ? [dayjs(value[0], DAY_FORMAT), dayjs(value[1], DAY_FORMAT)] : null}
      onChange={(dates) =>
        onChange(
          dates?.[0] && dates[1] ? [dates[0].format(DAY_FORMAT), dates[1].format(DAY_FORMAT)] : null,
        )
      }
    />
  )
}
