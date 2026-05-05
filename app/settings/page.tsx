'use client'

import { useState, useEffect } from 'react'
import {
  Key, Eye, EyeOff, Shield, CheckCircle, AlertTriangle,
  Trash2, ExternalLink, Info, AlertCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppSidebar } from '@/components/app-sidebar'
import { AppHeader } from '@/components/app-header'
import { AutoTradeControls } from '@/components/auto-trade-controls'
import {
  getSettings, saveSettings, getCredentials, saveCredentials, clearCredentials,
  calculatePortfolioStats,
} from '@/lib/trade-engine'
import type { TradingSettings, AccountCredentials } from '@/lib/types'

const EMPTY_CREDS: AccountCredentials = {
  private_key:     '',
  api_key:         '',
  api_secret:      '',
  api_passphrase:  '',
  funder_address:  '',
  signature_type:  0,
}

// ─── Validation ───────────────────────────────────────────────────────────────
const validateCreds = (creds: AccountCredentials): string[] => {
  const errors: string[] = []

  if (creds.private_key && !creds.private_key.startsWith('0x')) {
    errors.push('Private key must start with 0x')
  }
  if (creds.funder_address && !creds.funder_address.startsWith('0x')) {
    errors.push('Funder address must start with 0x')
  }
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (creds.api_key && !uuidRegex.test(creds.api_key)) {
    errors.push('API Key must be a valid UUID format')
  }
  const base64Regex = /^[A-Za-z0-9+/]+=*$/
  if (creds.api_secret && !base64Regex.test(creds.api_secret)) {
    errors.push('API Secret must be base64 encoded')
  }
  if (creds.api_key === 'YOUR_API_KEY') errors.push('Invalid API Key placeholder')

  return errors
}

export default function SettingsPage() {
  const [settings, setSettings]   = useState<TradingSettings>(getSettings())
  const [creds, setCreds]         = useState<AccountCredentials>(EMPTY_CREDS)
  const [showKeys, setShowKeys]   = useState(false)
  const [credsSaved, setCredsSaved] = useState(false)
  const [testing, setTesting]     = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const portfolio = calculatePortfolioStats()

  useEffect(() => {
    const stored = getCredentials()
    if (stored) setCreds({ ...EMPTY_CREDS, ...stored })
  }, [])

  useEffect(() => {
    setValidationErrors(validateCreds(creds))
  }, [creds])

  const handleSaveSettings = (s: TradingSettings) => {
    setSettings(s)
    saveSettings(s)
  }

  const handleSaveCreds = () => {
    const errors = validateCreds(creds)
    if (errors.length > 0) {
      setTestResult({ ok: false, msg: errors.join(', ') })
      return
    }
    saveCredentials(creds)
    setCredsSaved(true)
    setTestResult(null)
    setTimeout(() => setCredsSaved(false), 2500)
  }

  const handleTestConnection = async () => {
    setTesting(true)
    setTestResult(null)
    const clobCreds = creds.api_key
      ? {
          apiKey:        creds.api_key,
          apiSecret:     creds.api_secret,
          apiPassphrase: creds.api_passphrase,
          funderAddress: creds.funder_address,
          signatureType: creds.signature_type,
        }
      : undefined

    try {
      const res = await fetch('/api/portfolio', {
        headers: { 'X-Clob-Creds': clobCreds ? JSON.stringify(clobCreds) : '' },
      })
      const data = await res.json()
      if (data.error) {
        if (data.error.includes('Invalid signature') || data.error.includes('authentication failed')) {
          setTestResult({ ok: false, msg: 'Auth failed: Invalid credentials or signature type mismatch.' })
        } else {
          setTestResult({ ok: false, msg: `Error: ${data.error}` })
        }
      } else if (data.configured) {
        setTestResult({ ok: true, msg: `Connected! Balance: $${(data.balance ?? 0).toFixed(2)} USDC` })
      } else {
        setTestResult({ ok: false, msg: data.message ?? 'Credentials not configured or invalid.' })
      }
    } catch {
      setTestResult({ ok: false, msg: 'Network error. Check internet connection.' })
    } finally {
      setTesting(false)
    }
  }

  const handleClearCreds = () => {
    if (!confirm('Clear all saved credentials? This cannot be undone.')) return
    clearCredentials()
    setCreds(EMPTY_CREDS)
    setTestResult(null)
  }

  const filledCount = [
    creds.private_key, creds.api_key, creds.api_secret,
    creds.api_passphrase, creds.funder_address,
  ].filter(Boolean).length
  const allFilled = filledCount === 5

  return (
    <div className="flex min-h-screen bg-background">
      <AppSidebar autoTradeEnabled={settings.auto_trade_enabled} />

      <div className="flex-1 ml-16 lg:ml-56 min-w-0 flex flex-col">
        <AppHeader
          title="Settings"
          subtitle="Account credentials & trading configuration"
          balance={portfolio.total_balance}
          totalPnL={portfolio.total_pnl}
        />

        <main className="flex-1 p-4 overflow-auto">
          <div className="max-w-4xl mx-auto space-y-4">

            {/* Credentials Card */}
            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Key className="w-4 h-4 text-primary" />
                  <h3 className="text-sm font-semibold text-foreground">Polymarket Account Credentials</h3>
                  <span className={cn(
                    'text-xs px-2 py-0.5 rounded-full font-medium',
                    allFilled ? 'bg-profit/15 text-profit' : filledCount > 0 ? 'bg-chart-4/15 text-chart-4' : 'bg-loss/15 text-loss'
                  )}>
                    {allFilled ? 'Configured' : filledCount > 0 ? `${filledCount}/5 filled` : 'Not configured'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setShowKeys(!showKeys)}
                    className="w-8 h-8 flex items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-all"
                  >
                    {showKeys ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                  <a
                    href="https://docs.polymarket.com"
                    target="_blank"
                    rel="noreferrer"
                    className="w-8 h-8 flex items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-all"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>

              <div className="p-4 space-y-4">
                {/* Security notice */}
                <div className="flex gap-2 p-3 bg-chart-4/8 border border-chart-4/20 rounded-lg">
                  <Shield className="w-3.5 h-3.5 text-chart-4 shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Credentials stored only in your browser localStorage and sent to the server for signing.
                    Never share your private key with anyone.
                  </p>
                </div>

                {validationErrors.length > 0 && (
                  <div className="flex items-center gap-2 p-3 bg-loss/10 border border-loss/20 rounded-lg text-loss text-xs">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <div>
                      <p className="font-medium">Validation Errors:</p>
                      <ul className="list-disc list-inside">
                        {validationErrors.map((err, i) => <li key={i}>{err}</li>)}
                      </ul>
                    </div>
                  </div>
                )}

                {/* How-to guide */}
                <div className="p-3 bg-secondary/50 rounded-lg text-xs space-y-1 text-muted-foreground">
                  <p className="text-foreground font-medium mb-2">How to get your credentials:</p>
                  <p>1. Go to <a href="https://polymarket.com/settings" target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">polymarket.com/settings</a> and export your private key.</p>
                  <p>2. Run the Python SDK to generate API key, secret &amp; passphrase:</p>
                  <pre className="mt-1 p-2 bg-background rounded font-mono text-primary overflow-x-auto whitespace-pre-wrap leading-relaxed">{`pip install py-clob-client

python3 -c "
from py_clob_client.client import ClobClient
c = ClobClient('https://clob.polymarket.com',
  key='0xYOUR_PRIVATE_KEY', chain_id=137,
  signature_type=0,
  funder='0xYOUR_FUNDER_ADDRESS')
r = c.create_or_derive_api_creds()
print('API Key:', r.api_key)
print('Secret :', r.api_secret)
print('Pass   :', r.api_passphrase)
"`}</pre>
                  <p className="mt-1">3. Paste the output into the fields below and click <strong className="text-foreground">Save Credentials</strong>.</p>
                </div>

                {/* Credential fields */}
                <div className="grid md:grid-cols-2 gap-3">
                  <CredField
                    label="Wallet Private Key"
                    placeholder="0x..."
                    value={creds.private_key}
                    show={showKeys}
                    onChange={v => setCreds(c => ({ ...c, private_key: v }))}
                    hint="Your Polygon wallet private key — never expose this"
                  />

                  {/* ✅ FIXED: Hint funder_address akurat untuk setiap signature type */}
                  <CredField
                    label="Funder Address (Proxy Wallet)"
                    placeholder="0x..."
                    value={creds.funder_address}
                    show={showKeys}
                    onChange={v => setCreds(c => ({ ...c, funder_address: v }))}
                    hint={
                      creds.signature_type === 2
                        ? 'Alamat wallet yang terdaftar di polymarket.com/settings — biasanya sama dengan wallet browser kamu (Zerion, Rabby, dll)'
                        : creds.signature_type === 0
                        ? 'Alamat wallet MetaMask/EOA kamu — alamat ini digunakan untuk login langsung ke Polymarket'
                        : 'Alamat proxy wallet dari Polymarket (Poly Proxy) — gunakan signature_type 2 jika menggunakan browser wallet'
                    }
                  />

                  <CredField
                    label="CLOB API Key"
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    value={creds.api_key}
                    show={showKeys}
                    onChange={v => setCreds(c => ({ ...c, api_key: v }))}
                    hint="UUID from create_or_derive_api_creds()"
                  />
                  <CredField
                    label="CLOB API Secret"
                    placeholder="base64EncodedSecret..."
                    value={creds.api_secret}
                    show={showKeys}
                    onChange={v => setCreds(c => ({ ...c, api_secret: v }))}
                    hint="Base64-encoded — used for HMAC-SHA256 signing"
                  />
                  <CredField
                    label="CLOB API Passphrase"
                    placeholder="randomPassphrase..."
                    value={creds.api_passphrase}
                    show={showKeys}
                    onChange={v => setCreds(c => ({ ...c, api_passphrase: v }))}
                    hint="Random string from create_or_derive_api_creds()"
                  />

                  <div>
                    <label className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                      Login / Signature Type
                      <span title="Pilih sesuai metode login kamu ke Polymarket"><Info className="w-3 h-3" /></span>
                    </label>
                    <select
                      value={creds.signature_type}
                      onChange={e => setCreds(c => ({ ...c, signature_type: Number(e.target.value) as 0 | 1 | 2 }))}
                      className="w-full h-9 bg-secondary border border-border rounded-md px-3 text-sm text-foreground focus:outline-none focus:border-primary transition-colors"
                    >
                      <option value={2}>2 — GNOSIS_SAFE (Zerion / Browser Wallet di Polymarket)</option>
                      <option value={0}>0 — EOA (MetaMask langsung)</option>
                      <option value={1}>1 — POLY_PROXY (Email / Google / Magic Link)</option>
                    </select>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Gunakan <strong>2</strong> untuk Zerion atau browser wallet apapun yang terhubung ke Polymarket.
                      Gunakan <strong>0</strong> untuk MetaMask EOA langsung.
                      Gunakan <strong>1</strong> jika login via email/Google.
                    </p>
                  </div>
                </div>

                {testResult && (
                  <div className={cn(
                    'flex items-start gap-2 p-3 rounded-lg text-xs',
                    testResult.ok
                      ? 'bg-profit/10 border border-profit/20 text-profit'
                      : 'bg-loss/10 border border-loss/20 text-loss'
                  )}>
                    {testResult.ok
                      ? <CheckCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                    <span>{testResult.msg}</span>
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={handleSaveCreds}
                    className={cn(
                      'flex-1 h-9 rounded-md text-sm font-semibold transition-all',
                      credsSaved
                        ? 'bg-profit/10 border border-profit/30 text-profit'
                        : 'bg-primary text-primary-foreground hover:bg-primary/90'
                    )}
                  >
                    {credsSaved ? 'Saved!' : 'Save Credentials'}
                  </button>
                  <button
                    onClick={handleTestConnection}
                    disabled={testing || !creds.api_key || validationErrors.length > 0}
                    className="px-4 h-9 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {testing ? 'Testing...' : 'Test Connection'}
                  </button>
                  <button
                    onClick={handleClearCreds}
                    className="w-9 h-9 rounded-md border border-loss/30 flex items-center justify-center text-loss hover:bg-loss/10 transition-all"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="p-3 bg-primary/5 border border-primary/10 rounded-lg">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    <span className="text-primary font-medium">Production deployment: </span>
                    Add these as server-side environment variables in Vercel so credentials are never exposed in the browser.
                  </p>
                </div>
              </div>
            </div>

            {/* Auto-Trade Controls */}
            <AutoTradeControls settings={settings} onSave={handleSaveSettings} />

            {/* Env vars reference */}
            <div className="bg-card border border-border rounded-lg p-4">
              <h3 className="text-sm font-semibold text-foreground mb-3">Required Environment Variables (Vercel)</h3>
              <div className="space-y-2">
                {[
                  { key: 'POLY_PRIVATE_KEY',   desc: 'Your Polygon wallet private key (0x...) — for signing order structs' },
                  { key: 'POLY_API_KEY',        desc: 'CLOB API key (UUID) from create_or_derive_api_creds()' },
                  { key: 'POLY_SECRET',         desc: 'CLOB API secret (base64) for HMAC-SHA256 signing of request headers' },
                  { key: 'POLY_PASSPHRASE',     desc: 'CLOB API passphrase from create_or_derive_api_creds()' },
                  { key: 'FUNDER_ADDRESS',      desc: 'Your proxy wallet address from polymarket.com/settings' },
                  { key: 'SIGNATURE_TYPE',      desc: '0 = EOA (MetaMask) | 1 = POLY_PROXY (Email/Magic) | 2 = GNOSIS_SAFE [default: 0]' },
                  { key: 'POLY_BUILDER_CODE',   desc: 'Builder code (bytes32) dari Builder Profile Polymarket — untuk atribusi trading. Dikirim sebagai field pada setiap order di CLOB V2.' },
                ].map(env => (
                  <div key={env.key} className="flex items-start gap-3 text-xs">
                    <code className="font-mono text-primary bg-secondary px-2 py-0.5 rounded whitespace-nowrap shrink-0">
                      {env.key}
                    </code>
                    <span className="text-muted-foreground leading-relaxed">{env.desc}</span>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </main>
      </div>
    </div>
  )
}

function CredField({
  label, placeholder, value, show, onChange, hint,
}: {
  label: string; placeholder: string; value: string
  show: boolean; onChange: (v: string) => void; hint?: string
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1 block">{label}</label>
      <input
        type={show ? 'text' : 'password'}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        className="w-full h-9 bg-secondary border border-border rounded-md px-3 text-sm font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary transition-colors"
      />
      {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  )
}
