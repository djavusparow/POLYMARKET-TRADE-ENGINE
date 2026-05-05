// lib/clob-auth.ts
// CLOB V2 Migration — April 28, 2026
// Breaking changes:
// - EIP-712 domain version "1" → "2"
// - Exchange contract addresses → V2
// - Order struct: removed taker, expiration, nonce, feeRateBps
// - Order struct: added timestamp (ms), metadata (bytes32), builder (bytes32)
// - Builder attribution: POLY_BUILDER_* headers → builderCode field on order
// - Collateral: USDC.e → pUSD

import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'

// ==============================================
// Environment Variables
// ==============================================
const POLY_API_KEY     = process.env.POLY_API_KEY     ?? ''
const POLY_SECRET      = process.env.POLY_SECRET      ?? ''
const POLY_PASSPHRASE  = process.env.POLY_PASSPHRASE  ?? ''
const FUNDER_ADDRESS   = process.env.FUNDER_ADDRESS   ?? ''
const POLY_PRIVATE_KEY = process.env.POLY_PRIVATE_KEY ?? ''
const SIGNATURE_TYPE   = parseInt(process.env.SIGNATURE_TYPE ?? '2', 10)
const POLY_BUILDER_CODE = process.env.POLY_BUILDER_CODE ?? ''

// ==============================================
// V2 Contract Addresses
// ==============================================
export const CONTRACTS_V2 = {
  // Standard markets (non-neg-risk)
  CTF_EXCHANGE:   '0xE111180000d2663C0091e4f400237545B87B996B',
  // Neg-risk markets
  NEG_RISK_CTF:   '0xe2222d279d744050d28e00520010520000310F59',
  // pUSD collateral token
  PUSD:           '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
} as const

// EIP-712 domain version V2 = "2"
const DOMAIN_VERSION_V2 = '2'
const CHAIN_ID = 137n

// ==============================================
// V2 Order EIP-712 Type
// REMOVED: taker, expiration, nonce, feeRateBps
// ADDED:   timestamp, metadata, builder
// ==============================================
const ORDER_TYPE_V2 =
  'Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)'

// ==============================================
// Credentials Interface
// ==============================================
export interface ClobCreds {
  apiKey:        string
  apiSecret:     string
  apiPassphrase: string
  funderAddress: string
  signatureType: number
  privateKey:    string
  builderCode:   string
}

export function resolveCredentials(clientCreds?: any): ClobCreds | null {
  if (POLY_API_KEY && POLY_SECRET && POLY_PASSPHRASE && FUNDER_ADDRESS && POLY_PRIVATE_KEY) {
    return {
      apiKey:        POLY_API_KEY,
      apiSecret:     POLY_SECRET,
      apiPassphrase: POLY_PASSPHRASE,
      funderAddress: FUNDER_ADDRESS,
      signatureType: SIGNATURE_TYPE,
      privateKey:    POLY_PRIVATE_KEY,
      builderCode:   POLY_BUILDER_CODE,
    }
  }
  if (clientCreds?.apiKey && clientCreds?.apiSecret && clientCreds?.funderAddress) {
    return {
      apiKey:        clientCreds.apiKey,
      apiSecret:     clientCreds.apiSecret,
      apiPassphrase: clientCreds.apiPassphrase ?? '',
      funderAddress: clientCreds.funderAddress,
      signatureType: clientCreds.signatureType ?? 2,
      privateKey:    clientCreds.privateKey    ?? '',
      builderCode:   clientCreds.builderCode   ?? POLY_BUILDER_CODE,
    }
  }
  return null
}

// ==============================================
// CLOB L2 Auth Headers — HMAC-SHA256 (unchanged in V2)
// ==============================================
export async function buildClobHeaders(
  creds: ClobCreds,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body = ''
): Promise<Record<string, string>> {
  const timestamp      = Math.floor(Date.now() / 1000).toString()
  const pathWithoutQuery = path.split('?')[0]
  const normalizedPath = pathWithoutQuery.startsWith('/') ? pathWithoutQuery : `/${pathWithoutQuery}`
  const message        = `${timestamp}${method.toUpperCase()}${normalizedPath}${body}`

  // Secret is base64-encoded — decode before use
  const secretBytes  = Buffer.from(creds.apiSecret, 'base64')
  const messageBytes = new TextEncoder().encode(message)

  const sigBytes  = hmac(sha256, secretBytes, messageBytes)
  const signature = Buffer.from(sigBytes).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

  // POLY_ADDRESS = signer address (derived from private key), not funder address
  const signerAddress = creds.privateKey ? deriveSignerAddress(creds.privateKey) : creds.funderAddress

  return {
    'POLY_ADDRESS':    signerAddress,
    'POLY_SIGNATURE':  signature,
    'POLY_TIMESTAMP':  timestamp,
    'POLY_API_KEY':    creds.apiKey,
    'POLY_PASSPHRASE': creds.apiPassphrase,
    'Content-Type':    'application/json',
    // NOTE: POLY_BUILDER_* headers are REMOVED in V2
    // Builder attribution is now via builderCode field on the order struct
  }
}

// ==============================================
// Encoding Helpers
// ==============================================
export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  if (h.length % 2 !== 0) throw new Error('Invalid hex string')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

function encodeUint256(n: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let v = n < 0n ? (1n << 256n) + n : n
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n }
  return out
}

function encodeAddress(addr: string): Uint8Array {
  const out = new Uint8Array(32)
  const b   = hexToBytes(addr)
  out.set(b, 32 - b.length)
  return out
}

function encodeBytes32(hex: string): Uint8Array {
  // Pad or truncate to 32 bytes
  const h   = hex.startsWith('0x') ? hex.slice(2) : hex
  const padded = h.padEnd(64, '0').slice(0, 64)
  return hexToBytes(padded)
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrays) { out.set(a, off); off += a.length }
  return out
}

// ==============================================
// EIP-712 Domain Separator V2
// version "2", new verifyingContract addresses
// ==============================================
export function buildDomainSeparatorV2(negRisk = false): Uint8Array {
  const verifyingContract = negRisk ? CONTRACTS_V2.NEG_RISK_CTF : CONTRACTS_V2.CTF_EXCHANGE
  const domainTypeHash = keccak_256(new TextEncoder().encode(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
  ))
  const nameHash    = keccak_256(new TextEncoder().encode('Polymarket CTF Exchange'))
  const versionHash = keccak_256(new TextEncoder().encode(DOMAIN_VERSION_V2)) // "2" for V2
  return keccak_256(concat(
    domainTypeHash,
    nameHash,
    versionHash,
    encodeUint256(CHAIN_ID),
    encodeAddress(verifyingContract),
  ))
}

// ==============================================
// V2 Order Signing
// New struct: no taker, expiration, nonce, feeRateBps
// New fields: timestamp (ms), metadata (bytes32), builder (bytes32)
// ==============================================
export interface OrderV2Struct {
  salt:          bigint
  maker:         string
  signer:        string
  tokenId:       bigint
  makerAmount:   bigint
  takerAmount:   bigint
  side:          number   // 0=BUY, 1=SELL
  signatureType: number
  timestamp:     bigint   // milliseconds
  metadata:      string   // bytes32 hex
  builder:       string   // bytes32 hex (builderCode or zero)
}

export function encodeOrderV2ForSignature(order: OrderV2Struct): Uint8Array {
  const typeHash = keccak_256(new TextEncoder().encode(ORDER_TYPE_V2))
  return keccak_256(concat(
    typeHash,
    encodeUint256(order.salt),
    encodeAddress(order.maker),
    encodeAddress(order.signer),
    encodeUint256(order.tokenId),
    encodeUint256(order.makerAmount),
    encodeUint256(order.takerAmount),
    encodeUint256(BigInt(order.side)),
    encodeUint256(BigInt(order.signatureType)),
    encodeUint256(order.timestamp),
    encodeBytes32(order.metadata),
    encodeBytes32(order.builder),
  ))
}

export function signOrderDigest(privateKeyHex: string, digest: Uint8Array): string {
  const pkHex = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex
  const sig   = secp256k1.sign(digest, pkHex, { lowS: true })
  const r     = sig.r.toString(16).padStart(64, '0')
  const s     = sig.s.toString(16).padStart(64, '0')
  const v     = sig.recovery === 0 ? '1b' : '1c'
  return `0x${r}${s}${v}`
}

export function generateSalt(): number {
  return Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000)
}

// ==============================================
// Derive signer address from private key (EIP-55)
// ==============================================
function deriveSignerAddress(privateKeyHex: string): string {
  try {
    const pk        = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex
    const pubKey    = secp256k1.getPublicKey(pk, false)
    const pubBytes  = pubKey.slice(1)
    const hash      = keccak_256(pubBytes)
    const addrBytes = hash.slice(12)
    return toChecksumAddress(Array.from(addrBytes).map(b => b.toString(16).padStart(2, '0')).join(''))
  } catch {
    return ''
  }
}

function toChecksumAddress(addrHex: string): string {
  const addr    = addrHex.toLowerCase().replace('0x', '')
  const hash    = keccak_256(new TextEncoder().encode(addr))
  const hashHex = Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('')
  let result    = '0x'
  for (let i = 0; i < addr.length; i++) {
    result += parseInt(hashHex[i], 16) >= 8 ? addr[i].toUpperCase() : addr[i]
  }
  return result
}
