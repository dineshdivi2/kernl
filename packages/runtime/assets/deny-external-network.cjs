'use strict'

const net = require('node:net')
const dns = require('node:dns')
const dgram = require('node:dgram')

function isLoopback(host) {
  const normalized = String(host ?? 'localhost').toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1' || normalized.startsWith('127.')
}

function targetOf(args) {
  const first = args[0]
  if (first && typeof first === 'object') {
    if (first.path) return { local: true, target: first.path }
    return { local: isLoopback(first.host ?? first.hostname), target: first.host ?? first.hostname ?? 'localhost' }
  }
  if (typeof first === 'number') {
    const host = typeof args[1] === 'string' ? args[1] : 'localhost'
    return { local: isLoopback(host), target: host }
  }
  if (typeof first === 'string') return { local: true, target: first }
  return { local: false, target: 'unknown' }
}

const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function guardedConnect(...args) {
  const target = targetOf(args)
  if (!target.local) throw new Error(`Kernl verification denied external network target: ${target.target}`)
  return originalConnect.apply(this, args)
}

for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt']) {
  if (typeof dns[name] !== 'function') continue
  const original = dns[name]
  dns[name] = function guardedDns(hostname, ...args) {
    if (!isLoopback(hostname)) throw new Error(`Kernl verification denied external DNS target: ${hostname}`)
    return original.call(this, hostname, ...args)
  }
}

const originalDatagramSend = dgram.Socket.prototype.send
dgram.Socket.prototype.send = function guardedDatagramSend(...args) {
  const address = [...args].reverse().find(value => typeof value === 'string')
  if (address !== undefined && !isLoopback(address)) {
    throw new Error(`Kernl verification denied external datagram target: ${address}`)
  }
  return originalDatagramSend.apply(this, args)
}

if (typeof globalThis.fetch === 'function') {
  const originalFetch = globalThis.fetch
  globalThis.fetch = function guardedFetch(input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (!isLoopback(url.hostname)) throw new Error(`Kernl verification denied external fetch target: ${url.hostname}`)
    return originalFetch.call(this, input, init)
  }
}
