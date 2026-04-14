# Printer Bridge Server

Servidor local para recibir tickets JSON y mandarlos a imprimir en una PC que tiene la impresora conectada.

## 1) Instalar

```bash
cd printer-bridge-server
npm install
```

## 2) Configurar entorno

```bash
cp .env.example .env
```

Variables principales:

- `PORT`: puerto HTTP local del bridge (default `4100`).
- `PRINTER_ROUTE`: ruta donde recibe tickets (default `/print-ticket`).
- `PRINTER_NAME`: nombre exacto de impresora del SO (opcional; si no, usa impresora por defecto).
- `PRINTER_SHARE_PATH`: ruta compartida UNC para envio RAW en Windows (ej: `\\localhost\\EPSON_TM_T20`).
- `PRINTER_API_KEY`: si se define, exige header `x-printer-key`.
- `ALLOWED_ORIGIN`: origen permitido por CORS (default `*`).
- `DRY_RUN=true`: no imprime, solo genera archivo para test.
- `PAPER_WIDTH`: ancho en columnas del texto. Para ticket de 48mm, usa `32` como base.

## 3) Levantar

```bash
npm run dev
```

## 4) Conectar con tu app POS

En el proyecto principal:

```env
PRINTER_SERVER_URL=http://192.168.1.79:4100
PRINTER_SERVER_PRINT_PATH=/print-ticket
```

## 5) Healthcheck

```bash
curl http://localhost:4100/health
```

## 5.1) Ver impresoras detectadas (Windows)

```bash
curl http://localhost:4100/printers
```

Usa uno de esos nombres exactos en `PRINTER_NAME` para evitar que imprima en otro destino por defecto.

## 6) Prueba de impresión

```bash
curl -X POST http://localhost:4100/print-ticket \
  -H "Content-Type: application/json" \
  -d '{
    "ticket": {
      "orderId": "abc-123",
      "number": 12,
      "createdAt": 1760000000000,
      "createdAtIso": "2026-04-13T20:35:12.000Z",
      "status": "paid",
      "note": "sin cebolla",
      "items": [
        {"name":"Hamburguesa Cosmica","qty":2,"unitPrice":7500,"subtotal":15000},
        {"name":"Papas Orbita","qty":1,"unitPrice":3800,"subtotal":3800}
      ],
      "paymentBreakdown": [
        {"method":"efectivo","amount":18800}
      ],
      "total": 18800,
      "printedAtIso": "2026-04-13T20:36:05.000Z"
    }
  }'
```

## Notas por sistema operativo

- Windows: intenta RAW por `PRINTER_SHARE_PATH` (recomendado para termica), fallback a `cmd /c print` y luego `Start-Process -Verb Print/PrintTo`.
- macOS/Linux: usa `lp` y hace fallback a `lpr`.

Si necesitas formato ESC/POS o corte de papel, luego lo migras a una libreria especifica de tu impresora.
