import { DatePicker } from 'antd'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { DayRange } from '../lib/time'

interface DayRangeFilterProps {
  value: DayRange
  onChange: (range: DayRange) => void
  /** Which date the period applies to: the start of the booking or the creation of the record. */
  basis: 'starts' | 'created'
}

const DAY_FORMAT = 'YYYY-MM-DD'

/** Picks calendar days (interpreted as Asia/Tashkent days by lib/time). */
export function DayRangeFilter({ value, onChange, basis }: DayRangeFilterProps) {
  const { t } = useTranslation()
  const label = t(basis === 'starts' ? 'common.periodStarts' : 'common.periodCreated')
  return (
    <fieldset aria-label={label} title={label} style={{ border: 0, margin: 0, padding: 0 }}>
      <DatePicker.RangePicker
        allowClear
        format={DAY_FORMAT}
        value={value ? [dayjs(value[0], DAY_FORMAT), dayjs(value[1], DAY_FORMAT)] : null}
        onChange={(dates) =>
          onChange(
            dates?.[0] && dates[1] ? [dates[0].format(DAY_FORMAT), dates[1].format(DAY_FORMAT)] : null,
          )
        }
      />
    </fieldset>
  )
}
