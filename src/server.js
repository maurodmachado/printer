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
const PAPER_WIDTH = Math.max(24, Number(process.env.PAPER_WIDTH || 32))
const KEEP_TMP_FILES = String(process.env.KEEP_TMP_FILES || 'false').toLowerCase() === 'true'
const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true'
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'

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

function splitToken(token, width) {
  if (token.length <= width) {
    return [token]
  }

  const chunks = []
  for (let i = 0; i < token.length; i += width) {
    chunks.push(token.slice(i, i + width))
  }
  return chunks
}

function wrapText(text, width) {
  const raw = String(text ?? '').trim()
  if (!raw) {
    return ['']
  }

  const tokens = raw
    .split(/\s+/)
    .flatMap((token) => splitToken(token, width))

  const lines = []
  let current = ''

  for (const token of tokens) {
    if (!current) {
      current = token
      continue
    }

    if (`${current} ${token}`.length <= width) {
      current = `${current} ${token}`
      continue
    }

    lines.push(current)
    current = token
  }

  if (current) {
    lines.push(current)
  }

  return lines.length > 0 ? lines : ['']
}

function padRight(text, width) {
  const raw = String(text || '')
  if (raw.length >= width) return raw
  return `${raw}${' '.repeat(width - raw.length)}`
}

function itemLines(item, width) {
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

function buildTicketText(ticket) {
  const lines = []
  const separator = '-'.repeat(PAPER_WIDTH)
  const createdAtLabel = ticket.createdAt
    ? new Date(ticket.createdAt).toLocaleString('es-AR')
    : new Date().toLocaleString('es-AR')

  lines.push(center('🛸 CÓSMICO 🛸', PAPER_WIDTH))
  lines.push(separator)
  lines.push('')
  lines.push(center(`ORDEN #${ticket.number ?? ''}`, PAPER_WIDTH))
  lines.push('')
  lines.push(separator)
  lines.push(`Fecha: ${createdAtLabel}`)
  lines.push(separator)

  const items = Array.isArray(ticket.items) ? ticket.items : []
  for (const item of items) {
    lines.push(...itemLines(item, PAPER_WIDTH))
  }

  lines.push(separator)

  const payments = Array.isArray(ticket.paymentBreakdown) ? ticket.paymentBreakdown : []
  if (payments.length > 0) {
    for (const payment of payments) {
      const method = String(payment.method || 'otro')
      const amount = formatMoney(payment.amount)
      lines.push(...wrapText(`Pago: ${method} - ${amount}`, PAPER_WIDTH))
    }
  }
lines.push(separator)
  lines.push(`TOTAL: ${formatMoney(ticket.total)}`)
  lines.push(separator)

  if (ticket.note) {
    lines.push(...wrapText(`Nota: ${ticket.note}`, PAPER_WIDTH))
    lines.push(separator)
  }

  lines.push('')
  lines.push(center('Sabores de otra galaxia', PAPER_WIDTH))
  lines.push('')
  lines.push(center('Ticket no valido como factura', PAPER_WIDTH - 12))
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
    try {
      const notepadArgs = PRINTER_NAME ? ['/pt', filePath, PRINTER_NAME] : ['/p', filePath]
      logInfo('Intentando imprimir con notepad', {
        filePath,
        printerName: PRINTER_NAME || '(default)',
      })
      await execFileAsync('notepad', notepadArgs)
      logInfo('Impresion OK via notepad', {
        filePath,
        printerName: PRINTER_NAME || '(default)',
      })
      return
    } catch (notepadError) {
      try {
        const args = PRINTER_NAME ? ['/c', 'print', `/D:${PRINTER_NAME}`, filePath] : ['/c', 'print', filePath]
        logInfo('Fallback a PRINT de cmd', {
          filePath,
          printerName: PRINTER_NAME || '(default)',
        })
        await execFileAsync('cmd', args)
        logInfo('Impresion OK via PRINT', {
          filePath,
          printerName: PRINTER_NAME || '(default)',
        })
        return
      } catch (cmdError) {
        const notepadMessage = notepadError?.stderr || notepadError?.message || 'NOTEPAD print failed'
        const cmdMessage = cmdError?.stderr || cmdError?.message || 'PRINT failed'
        throw new Error(`Windows print failed. NOTEPAD: ${notepadMessage}. PRINT: ${cmdMessage}`)
      }
    }
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

async function listWindowsPrinters() {
  if (process.platform !== 'win32') {
    return []
  }

  const script = 'Get-Printer | Select-Object -ExpandProperty Name'
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script])
  return String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

app.get('/health', (_req, res) => {
  logInfo('Health check consultado', {
    route: PRINTER_ROUTE,
    dryRun: DRY_RUN,
    printerName: PRINTER_NAME || '(default)',
    platform: os.platform(),
  })
  res.json({
    ok: true,
    service: 'printer-bridge-server',
    route: PRINTER_ROUTE,
    dryRun: DRY_RUN,
    printerName: PRINTER_NAME || '(default)',
    platform: os.platform(),
  })
})

app.get('/printers', async (_req, res) => {
  try {
    const printers = await listWindowsPrinters()
    logInfo('Listado de impresoras obtenido', {
      count: printers.length,
      printers,
    })
    res.json({ ok: true, printers })
  } catch (error) {
    logError('Fallo al listar impresoras', error)
    res.status(500).json({ error: error.message || 'No se pudo listar impresoras' })
  }
})

app.post(PRINTER_ROUTE, async (req, res) => {
  try {
    logInfo('Inicio de procesamiento de ticket', {
      requestId: req.requestId,
    })

    if (PRINTER_API_KEY) {
      const key = String(req.headers['x-printer-key'] || '')
      if (key !== PRINTER_API_KEY) {
        logInfo('Ticket rechazado por API key invalida', {
          requestId: req.requestId,
        })
        return res.status(401).json({ error: 'Unauthorized printer key' })
      }
    }

    assertPayload(req.body)
    logInfo('Payload validado', {
      requestId: req.requestId,
    })

    const ticket = req.body.ticket
    const text = buildTicketText(ticket)
    const tmpDir = await ensureTmpDir()
    const fileName = `ticket-${ticket.number || 'na'}-${randomUUID()}.txt`
    const filePath = path.join(tmpDir, fileName)

    await fs.writeFile(filePath, text, 'utf8')
    logInfo('Ticket serializado en archivo temporal', {
      requestId: req.requestId,
      filePath,
      ticketNumber: ticket.number ?? null,
      itemsCount: Array.isArray(ticket.items) ? ticket.items.length : 0,
      total: ticket.total ?? 0,
    })

    if (!DRY_RUN) {
      await printFile(filePath)
      logInfo('Ticket enviado al sistema de impresion', {
        requestId: req.requestId,
        filePath,
      })
      if (!KEEP_TMP_FILES) {
        await fs.unlink(filePath).catch(() => {})
        logInfo('Archivo temporal eliminado', {
          requestId: req.requestId,
          filePath,
        })
      }
    } else {
      logInfo('DRY_RUN activo: no se envio a impresora', {
        requestId: req.requestId,
        filePath,
      })
    }

    logInfo('Proceso de ticket finalizado OK', {
      requestId: req.requestId,
      ticketNumber: ticket.number ?? null,
    })
    return res.status(200).json({
      ok: true,
      printed: !DRY_RUN,
      dryRun: DRY_RUN,
      filePath,
      ticketNumber: ticket.number ?? null,
    })
  } catch (error) {
    logError('Proceso de ticket fallo', error, {
      requestId: req.requestId,
    })
    return res.status(500).json({ error: error.message || 'Print relay failed' })
  }
})

app.listen(PORT, () => {
  logInfo('Printer bridge activo', {
    url: `http://localhost:${PORT}${PRINTER_ROUTE}`,
    port: PORT,
    route: PRINTER_ROUTE,
    printerName: PRINTER_NAME || '(default)',
    dryRun: DRY_RUN,
    keepTmpFiles: KEEP_TMP_FILES,
    platform: os.platform(),
  })
})
