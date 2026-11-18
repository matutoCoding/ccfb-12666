import * as XLSX from 'xlsx'
import type { ReportRow } from '../types'
import { download } from '../ui/dom'

function fmtDelta(v?: number) {
  if (v === undefined) return '—'
  return `${v > 0 ? '+' : ''}${v}`
}

function rowsToSheet(rows: ReportRow[]): XLSX.WorkSheet {
  const data = rows.map(r => ({
    '周期': r.period,
    '泊位利用率(%)': r.berthUtil,
    '岸桥单机效率(moves/h)': r.qcEfficiency,
    '集卡平均等待(min)': r.truckWait,
    '堆场翻箱率(%)': r.rehandleRate,
    '利用率环比': fmtDelta(r.deltas?.berthUtil),
    '效率环比': fmtDelta(r.deltas?.qcEfficiency),
    '等待环比': fmtDelta(r.deltas?.truckWait),
    '翻箱率环比': fmtDelta(r.deltas?.rehandleRate)
  }))
  const ws = XLSX.utils.json_to_sheet(data)
  ws['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }]
  return ws
}

/** 浏览器端导出 Excel（SheetJS），无后端 */
export function exportReportsExcel(daily: ReportRow[], weekly: ReportRow[]) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, rowsToSheet(daily), '日报')
  XLSX.utils.book_append_sheet(wb, rowsToSheet(weekly), '周报')
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  download(`码头作业统计报表_${new Date().toISOString().slice(0, 10)}.xlsx`,
    new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
}
