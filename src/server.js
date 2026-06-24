import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

dotenv.config()

const execAsync = promisify(exec)
const app = express()

const PORT = Number(process.env.PORT || 4100)
const PRINTER_ROUTE = process.env.PRINTER_ROUTE || '/print-ticket'
const OPEN_DRAWER_ROUTE = process.env.OPEN_DRAWER_ROUTE || '/open-drawer'
const PRINTER_SHARE_PATH = (process.env.PRINTER_SHARE_PATH || '').trim()
const PRINTER_API_KEY = (process.env.PRINTER_API_KEY || '').trim()
const PAPER_WIDTH = Math.max(24, Number(process.env.PAPER_WIDTH || 48))
const KEEP_TMP_FILES = String(process.env.KEEP_TMP_FILES || 'false').toLowerCase() === 'true'
const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true'
const OPEN_CASH_DRAWER = String(process.env.OPEN_CASH_DRAWER || 'true').toLowerCase() === 'true'
const CASH_DRAWER_PIN = Number(process.env.CASH_DRAWER_PIN || 2)
const AUTO_CUT = String(process.env.AUTO_CUT || 'true').toLowerCase() === 'true'
const WIN_PRINT_ORDER = ["share"]
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'

const separator = '-'.repeat(PAPER_WIDTH)

function logInfo(message, meta = {}) {
  const timestamp = new Date().toISOString()
  const details = Object.keys(meta).length > 0 ? ` | ${JSON.stringify(meta)}` : ''
  console.log(`[${timestamp}] INFO  ${message}${details}`)
}

function logError(message, error, meta = {}) {
  const timestamp = new Date().toISOString()
  const payload = {
    ...meta,
    error: error?.message || String(error),
  }
  console.error(`[${timestamp}] ERROR ${message} | ${JSON.stringify(payload)}`)
}

app.use(cors({ origin: ALLOWED_ORIGIN }))
app.use(express.json({ limit: '1mb' }))

app.use((req, _res, next) => {
  req.requestId = randomUUID()
  logInfo('Request recibido', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    ip: req.ip,
  })
  next()
})

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

function wrapText(text, width) {
  const raw = String(text ?? '').trim()
  if (!raw) return ['']

  const words = raw.split(/\s+/)
  const lines = []
  let current = ''

  for (const word of words) {
    if ((current + ' ' + word).trim().length <= width) {
      current = (current + ' ' + word).trim()
    } else {
      lines.push(current)
      current = word
    }
  }

  if (current) lines.push(current)
  return lines
}

function padRight(text, width) {
  const raw = String(text || '')
  if (raw.length >= width) return raw
  return raw + ' '.repeat(width - raw.length)
}

function itemLines(item, width, ticket) {
  const qty = Number(item.qty || 0)
  const unitPrice = Number(item.unitPrice ?? item.price ?? 0)
  const subtotal = Number(item.subtotal ?? qty * unitPrice)
  const right = formatMoney(subtotal)
  const rightWidth = Math.max(9, right.length)
  const leftWidth = Math.max(10, width - rightWidth - 1)

  const nameLines = wrapText(String(item.name || 'Item'), Math.max(6, leftWidth - 3))
  const firstLeft = `${qty}x ${nameLines[0] || ''}`
  const lines = []

  if (firstLeft.length + 1 + right.length <= width) {
    lines.push(`${padRight(firstLeft, leftWidth)} ${right}`)
  } else {
    lines.push(firstLeft)
    lines.push(right.padStart(width, ' '))
  }

  for (let i = 1; i < nameLines.length; i += 1) {
    lines.push(nameLines[i])
  }

  return lines
}

function capitalize(text){
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildTicketText(ticket) {
 const lines = []
  const createdAtLabel = ticket.createdAt
    ? new Date(ticket.createdAt).toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year:'2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
    : new Date().toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year:'2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
  lines.push(center('COSMICO - @cosmico.cta', PAPER_WIDTH))
  lines.push('')
  lines.push(center(`ORDEN #${ticket.number ?? ''}`, PAPER_WIDTH))
  lines.push('')
  lines.push(`Fecha: ${createdAtLabel}`)

  lines.push(separator)
const items = Array.isArray(ticket.items) ? ticket.items : []
  for (const item of items) {
    lines.push(...itemLines(item, PAPER_WIDTH, ticket))
  }

  const rightWidth = Math.max(9, 8)
  const leftWidth = Math.max(10, PAPER_WIDTH - rightWidth - 1)

  lines.push('')
  lines.push(`${padRight('TOTAL', leftWidth)} ${formatMoney(ticket.total)}`)
  lines.push(separator)

  const payments = Array.isArray(ticket.paymentBreakdown) ? ticket.paymentBreakdown : []
  if (payments.length > 0) {
    for (const payment of payments) {
      const method = capitalize(String(payment.method || 'otro'))
      const amount = formatMoney(payment.amount)
      lines.push(...wrapText(`Pago: ${method} - ${amount}`, PAPER_WIDTH))
    }
  }

  if (ticket.note) {
    lines.push(...wrapText(`Nota: ${ticket.note}`, PAPER_WIDTH))
    lines.push(separator)
  }

  lines.push('')
  lines.push(center('¡Gracias por tu compra!', PAPER_WIDTH))
  lines.push('')
  lines.push(center('SABORES DE OTRA GALAXIA', PAPER_WIDTH))
  lines.push('')
  lines.push(center('Ticket no válido como factura', PAPER_WIDTH))
  lines.push('')
  lines.push('')

  return `${lines.join('\n')}\n`
}

function buildDrawerKickBuffer(drawerPin = CASH_DRAWER_PIN) {
  const pin = drawerPin === 5 ? 1 : 0
  return Buffer.from([0x1b, 0x70, pin, 0x19, 0xfa])
}

function buildEscPosTail({ openDrawer = true, cut = true, drawerPin = CASH_DRAWER_PIN } = {}) {
  const chunks = []

  if (cut) {
    chunks.push(Buffer.from([0x0a, 0x0a, 0x0a]))
    chunks.push(Buffer.from([0x1d, 0x56, 0x00]))
  }

  if (openDrawer) {
    chunks.push(buildDrawerKickBuffer(drawerPin))
  }

  return Buffer.concat(chunks)
}

function buildTicketBuffer(ticket, options = {}) {
  const openDrawer = options.openDrawer ?? OPEN_CASH_DRAWER
  const cut = options.cut ?? AUTO_CUT
  const drawerPin = options.drawerPin ?? CASH_DRAWER_PIN
  const text = buildTicketText(ticket)

  return Buffer.concat([
    Buffer.from(text, 'utf8'),
    buildEscPosTail({ openDrawer, cut, drawerPin }),
  ])
}

async function ensureTmpDir() {
  const target = path.join(process.cwd(), 'tmp')
  await fs.mkdir(target, { recursive: true })
  return target
}

async function sendRawBuffer(buffer, filePrefix) {
  const tmpDir = await ensureTmpDir()
  const filePath = path.join(tmpDir, `${filePrefix}-${randomUUID()}.bin`)

  await fs.writeFile(filePath, buffer)

  logInfo('Archivo RAW creado', { filePath, bytes: buffer.length })

  if (!DRY_RUN) {
    await printFile(filePath)

    if (!KEEP_TMP_FILES) {
      await fs.unlink(filePath).catch(() => {})
    }
  }

  return filePath
}

function isUnauthorized(req) {
  return PRINTER_API_KEY && req.headers['x-printer-key'] !== PRINTER_API_KEY
}

async function printFile(filePath) {
  if (process.platform !== 'win32') {
    throw new Error('Solo soportado en Windows')
  }

  const errors = []

  for (const method of WIN_PRINT_ORDER) {
    if (method === 'share') {
      if (!PRINTER_SHARE_PATH) {
        throw new Error('PRINTER_SHARE_PATH no definido')
      }

      try {
        const command = `cmd /c copy /b "${filePath}" "${PRINTER_SHARE_PATH}"`

        logInfo('Intentando imprimir', { command })

        const { stdout, stderr } = await execAsync(command)

        logInfo('Impresión OK', { stdout, stderr })
        return
      } catch (error) {
        console.error('STDERR REAL:', error.stderr)

        errors.push({
          method: 'share',
          error: error.stderr || error.message,
        })
      }
    }
  }

  throw new Error(
    'Windows print failed → ' +
      errors.map(e => `${e.method}: ${e.error}`).join(' | ')
  )
}

function assertPayload(payload) {
  if (!payload?.ticket?.items?.length) {
    throw new Error('Ticket inválido')
  }
}

app.post(PRINTER_ROUTE, async (req, res) => {
  try {
    if (isUnauthorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    assertPayload(req.body)

    const ticket = req.body.ticket
    const openDrawer = req.body.openDrawer ?? OPEN_CASH_DRAWER
    const cut = req.body.cut ?? AUTO_CUT
    const buffer = buildTicketBuffer(ticket, { openDrawer, cut })

    await sendRawBuffer(buffer, 'ticket')

    res.json({ ok: true, openDrawer, cut })
  } catch (error) {
    logError('Error imprimiendo', error)
    res.status(500).json({ error: error.message })
  }
})

app.post(OPEN_DRAWER_ROUTE, async (req, res) => {
  try {
    if (isUnauthorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const drawerPin = Number(req.body?.drawerPin ?? CASH_DRAWER_PIN)
    if (drawerPin !== 2 && drawerPin !== 5) {
      return res.status(400).json({ error: 'drawerPin debe ser 2 o 5' })
    }

    const buffer = buildDrawerKickBuffer(drawerPin)

    await sendRawBuffer(buffer, 'drawer')

    logInfo('Comando de apertura de gaveta enviado', { drawerPin, dryRun: DRY_RUN })

    res.json({ ok: true, drawerPin, dryRun: DRY_RUN })
  } catch (error) {
    logError('Error abriendo gaveta', error)
    res.status(500).json({ error: error.message })
  }
})

app.listen(PORT, () => {
  logInfo('Printer bridge activo', {
    printUrl: `http://localhost:${PORT}${PRINTER_ROUTE}`,
    openDrawerUrl: `http://localhost:${PORT}${OPEN_DRAWER_ROUTE}`,
  })
})