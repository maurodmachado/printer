import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

dotenv.config()

const execFileAsync = promisify(execFile)
const app = express()

const PORT = Number(process.env.PORT || 4100)
const PRINTER_ROUTE = process.env.PRINTER_ROUTE || '/print-ticket'
const PRINTER_NAME = (process.env.PRINTER_NAME || '').trim()
const PRINTER_API_KEY = (process.env.PRINTER_API_KEY || '').trim()
const PAPER_WIDTH = Math.max(30, Number(process.env.PAPER_WIDTH || 42))
const KEEP_TMP_FILES = String(process.env.KEEP_TMP_FILES || 'false').toLowerCase() === 'true'
const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true'
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'

app.use(cors({ origin: ALLOWED_ORIGIN }))
app.use(express.json({ limit: '1mb' }))

function formatMoney(amount) {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(Number(amount || 0))
}

function center(text, width) {
  const clean = String(text || '')
  if (clean.length >= width) return clean
  const left = Math.floor((width - clean.length) / 2)
  return `${' '.repeat(left)}${clean}`
}

function clampLine(text, width) {
  const value = String(text || '')
  if (value.length <= width) return value
  if (width <= 3) return value.slice(0, width)
  return `${value.slice(0, width - 3)}...`
}

function padRight(text, width) {
  const raw = String(text || '')
  if (raw.length >= width) return raw
  return `${raw}${' '.repeat(width - raw.length)}`
}

function itemLine(item, width) {
  const qty = Number(item.qty || 0)
  const unitPrice = Number(item.unitPrice ?? item.price ?? 0)
  const subtotal = Number(item.subtotal ?? qty * unitPrice)
  const left = `${qty}x ${item.name || 'Item'}`
  const right = formatMoney(subtotal)

  const rightWidth = Math.max(10, right.length)
  const leftWidth = Math.max(8, width - rightWidth - 1)

  return `${padRight(clampLine(left, leftWidth), leftWidth)} ${right}`
}

function buildTicketText(ticket) {
  const lines = []
  const separator = '-'.repeat(PAPER_WIDTH)

  lines.push(center('COSMICO', PAPER_WIDTH))
  lines.push(separator)
  lines.push(`Ticket #${ticket.number ?? ''}`)
  lines.push(`Fecha: ${ticket.createdAtIso || new Date(ticket.createdAt || Date.now()).toISOString()}`)
  if (ticket.status) lines.push(`Estado: ${ticket.status}`)
  lines.push(separator)

  const items = Array.isArray(ticket.items) ? ticket.items : []
  for (const item of items) {
    lines.push(itemLine(item, PAPER_WIDTH))
  }

  lines.push(separator)

  const payments = Array.isArray(ticket.paymentBreakdown) ? ticket.paymentBreakdown : []
  if (payments.length > 0) {
    lines.push('Pago:')
    for (const payment of payments) {
      const method = String(payment.method || 'otro')
      lines.push(`- ${method}: ${formatMoney(payment.amount)}`)
    }
  }

  lines.push(`TOTAL: ${formatMoney(ticket.total)}`)

  if (ticket.note) {
    lines.push(separator)
    lines.push(`Nota: ${ticket.note}`)
  }

  lines.push('')
  lines.push(center('Gracias por tu compra', PAPER_WIDTH))
  lines.push('')
  lines.push('')
  lines.push('')

  return `${lines.join('\n')}\n`
}

async function ensureTmpDir() {
  const target = path.join(process.cwd(), 'tmp')
  await fs.mkdir(target, { recursive: true })
  return target
}

async function printFile(filePath) {
  if (process.platform === 'win32') {
    const printerArg = PRINTER_NAME.replace(/'/g, "''")
    const fileArg = filePath.replace(/'/g, "''")
    const command = PRINTER_NAME
      ? `$c = Get-Content -Path '${fileArg}'; $c | Out-Printer -Name '${printerArg}'`
      : `$c = Get-Content -Path '${fileArg}'; $c | Out-Printer`

    await execFileAsync('powershell', ['-NoProfile', '-Command', command])
    return
  }

  try {
    const args = PRINTER_NAME ? ['-d', PRINTER_NAME, filePath] : [filePath]
    await execFileAsync('lp', args)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }

    const args = PRINTER_NAME ? ['-P', PRINTER_NAME, filePath] : [filePath]
    await execFileAsync('lpr', args)
  }
}

function assertPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Body invalido: se esperaba JSON')
  }

  if (!payload.ticket || typeof payload.ticket !== 'object') {
    throw new Error('Body invalido: falta objeto ticket')
  }

  if (!Array.isArray(payload.ticket.items) || payload.ticket.items.length === 0) {
    throw new Error('Body invalido: ticket.items debe tener al menos un item')
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'printer-bridge-server',
    route: PRINTER_ROUTE,
    dryRun: DRY_RUN,
    printerName: PRINTER_NAME || '(default)',
    platform: os.platform(),
  })
})

app.post(PRINTER_ROUTE, async (req, res) => {
  try {
    if (PRINTER_API_KEY) {
      const key = String(req.headers['x-printer-key'] || '')
      if (key !== PRINTER_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized printer key' })
      }
    }

    assertPayload(req.body)

    const ticket = req.body.ticket
    const text = buildTicketText(ticket)
    const tmpDir = await ensureTmpDir()
    const fileName = `ticket-${ticket.number || 'na'}-${randomUUID()}.txt`
    const filePath = path.join(tmpDir, fileName)

    await fs.writeFile(filePath, text, 'utf8')

    if (!DRY_RUN) {
      await printFile(filePath)
      if (!KEEP_TMP_FILES) {
        await fs.unlink(filePath).catch(() => {})
      }
    }

    return res.status(200).json({
      ok: true,
      printed: !DRY_RUN,
      dryRun: DRY_RUN,
      filePath,
      ticketNumber: ticket.number ?? null,
    })
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Print relay failed' })
  }
})

app.listen(PORT, () => {
  console.log(`Printer bridge activo en http://localhost:${PORT}${PRINTER_ROUTE}`)
})
