import { Button, message } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExportColumn } from '../lib/exportXlsx'
import { PaginationLimitError } from '../lib/fetchAll'
import { Can } from './Can'

interface ExportButtonProps<T> {
  /** File name without extension (letters, digits, dot, dash, underscore). */
  filename: string
  columns: ExportColumn<T>[]
  /** Reads ALL rows of the current filter (not just the visible page). */
  loadRows: () => Promise<T[]>
}

/**
 * Client-side Excel export. The workbook code is loaded on click (its own chunk); every cell is
 * formula-injection safe (see lib/exportXlsx). Hidden for roles without the export right.
 */
export function ExportButton<T>({ filename, columns, loadRows }: ExportButtonProps<T>) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

  async function run() {
    if (busy) return
    setBusy(true)
    try {
      const rows = await loadRows()
      const { downloadXlsx, rowsFromColumns } = await import('../lib/exportXlsx')
      downloadXlsx(filename, rowsFromColumns(columns, rows), filename)
    } catch (error) {
      void message.error(
        error instanceof PaginationLimitError ? t('export.tooMany') : t('export.failed'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Can action="export">
      <Button loading={busy} onClick={() => void run()}>
        {t('export.button')}
      </Button>
    </Can>
  )
}
