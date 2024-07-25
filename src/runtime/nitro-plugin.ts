import { createServer } from 'node:http'
import prometheusClient from 'prom-client'
import consola from 'consola'
import type { NitroApp } from 'nitropack'
import health from './health'
import handler from './handler'
// @ts-expect-error no types
import { config } from '#prometheus-options'

type NitroAppPlugin = (nitro: NitroApp) => void

const defineNitroPlugin = (def: NitroAppPlugin): NitroAppPlugin => def

prometheusClient.register.setContentType(
  // @ts-expect-error no types
  prometheusClient.Registry.OPENMETRICS_CONTENT_TYPE,
)

export default defineNitroPlugin((nitroApp) => {
  const httpRequestDurationMicroseconds = new prometheusClient.Histogram({
    name: 'http_request_duration_ms',
    help: 'Duration of HTTP requests in ms',
    labelNames: ['method', 'route', 'code'],
    buckets: [0.1, 5, 15, 50, 100, 200, 300, 400, 500],
  })

  const server = createServer(async (req, res) => {
    const { url } = req
    if (config.healthCheck && url === config.healthCheckPath) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(health({ req, res } as any))
    }
    else if (url === config.prometheusPath) {
      await handler({ req, res } as any)
    }
    else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    }
  })
  server.listen(config.port, config.host)

  if (config.verbose) {
    server.on('listening', () => {
      consola.info(`Prometheus metrics available at http://${config.host}:${config.port}${config.prometheusPath}`)
    })
  }

  nitroApp.hooks.hook('close', async () => {
    server.close()
  })

  nitroApp.hooks.hook('request', async ({ context }) => {
    context.endPromTimer = httpRequestDurationMicroseconds.startTimer()
  })

  nitroApp.hooks.hook('afterResponse', async ({ context, node: { req, res } }) => {
    if (context.endPromTimer) {
      let route = context.matchedRoute?.path ?? req.originalUrl
      if (route && !config.urlWithQuery)
        route = route.split('?')[0]

      try {
        context.endPromTimer({
          method: req.method,
          route,
          code: res.statusCode,
        })
      }
      catch (e) {
        console.error(e)
      }
    }
  })
})
