'use client'

import { useState, useEffect } from 'react'
import { Settings2, Shield, TrendingUp, Sliders, Save, Info, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TradingSettings } from '@/lib/types'
import {
  getCryptoSettings,
  saveCryptoSettings,
  type CryptoUpDownSettings,
  DEFAULT_CRYPTO_SETTINGS,
} from '@/lib/trade-engine'

interface AutoTradeControlsProps {
  settings: TradingSettings
  onSave: (settings: TradingSettings) => void
  /** Optional market minimum order size for validation */
  minimumOrderSize?: number
}

export function AutoTradeControls({ settings, onSave, minimumOrderSize }: AutoTradeControlsProps) {
  const [local, setLocal] = useState<TradingSettings>(settings)
  const [cryptoSettings, setCryptoSettings] = useState<CryptoUpDownSettings>(getCryptoSettings())
  const [saved, setSaved] = useState(false)
  const [cryptoSaved, setCryptoSaved] = useState(false)

  // Sync crypto settings from localStorage on mount
  useEffect(() => {
    setCryptoSettings(getCryptoSettings())
  }, [])

  const update = (key: keyof TradingSettings, value: unknown) => {
    setLocal(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  const updateCrypto = (key: keyof CryptoUpDownSettings, value: unknown) => {
    setCryptoSettings(prev => ({ ...prev, [key]: value }))
    setCryptoSaved(false)
  }

  // ── Simpan Polymarket settings ───────────────────────────────────────────
  const handleSave = () => {
    onSave(local)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  // ── Simpan Crypto settings + EMIT EVENT ──────────────────────────────────
  const handleCryptoSave = () => {
    saveCryptoSettings(cryptoSettings)
    setCryptoSaved(true)

    // ✅ EMIT EVENT — memberitahu halaman crypto bahwa settings berubah
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('crypto-settings-changed'))
    }

    setTimeout(() => setCryptoSaved(false), 2000)
  }

  // ── Toggle coin + simpan langsung ────────────────────────────────────────
  const handleToggleCoin = (coin: string) => {
    const newCoins = cryptoSettings.enabled_coins.includes(coin)
      ? cryptoSettings.enabled_coins.filter(c => c !== coin)
      : [...cryptoSettings.enabled_coins, coin]

    const updated = { ...cryptoSettings, enabled_coins: newCoins }
    setCryptoSettings(updated)
    saveCryptoSettings(updated)
    setCryptoSaved(false)

    // ✅ EMIT EVENT agar perubahan langsung terdeteksi
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('crypto-settings-changed'))
    }
  }

  // ── Toggle window + simpan langsung ──────────────────────────────────────
  const handleToggleWindow = (w: string) => {
    const newWindows = cryptoSettings.enabled_windows.includes(w)
      ? cryptoSettings.enabled_windows.filter(x => x !== w)
      : [...cryptoSettings.enabled_windows, w]

    const updated = { ...cryptoSettings, enabled_windows: newWindows }
    setCryptoSettings(updated)
    saveCryptoSettings(updated)
    setCryptoSaved(false)

    // ✅ EMIT EVENT agar perubahan langsung terdeteksi
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('crypto-settings-changed'))
    }
  }

  // ── Toggle master switch + simpan langsung ───────────────────────────────
  const handleToggleMaster = () => {
    const updated = { ...cryptoSettings, auto_trade_enabled: !cryptoSettings.auto_trade_enabled }
    setCryptoSettings(updated)
    saveCryptoSettings(updated)
    setCryptoSaved(false)

    // ✅ EMIT EVENT
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('crypto-settings-changed'))
    }
  }

  // Calculate effective minimum based on market requirements and user settings
  const effectiveMinSize = Math.max(minimumOrderSize ?? 1, local.min_trade_size)

  return (
    <div className="space-y-6">
      {/* ── POLYMARKET SETTINGS ──────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Sliders className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Polymarket Auto Trade</h3>
        </div>

        <div className="p-4 space-y-5">
          {/* Master switch */}
          <div className="flex items-center justify-between p-3 bg-secondary/50 rounded-lg border border-border">
            <div>
              <p className="text-sm font-medium text-foreground">Auto Trade</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Automatically execute trades when confidence exceeds threshold
              </p>
            </div>
            <button
              onClick={() => update('auto_trade_enabled', !local.auto_trade_enabled)}
              className={cn(
                'relative w-11 h-6 rounded-full transition-all duration-200 shrink-0',
                local.auto_trade_enabled ? 'bg-profit' : 'bg-secondary border border-border'
              )}
            >
              <div className={cn(
                'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all duration-200',
                local.auto_trade_enabled ? 'left-[22px]' : 'left-0.5'
              )} />
            </button>
          </div>

          {/* Confidence threshold */}
          <SliderField
            icon={Shield}
            label="Min Confidence Threshold"
            description="Only trade when AI ensemble confidence exceeds this value"
            value={local.min_confidence}
            min={50}
            max={95}
            step={5}
            unit="%"
            color={local.min_confidence >= 80 ? 'profit' : local.min_confidence >= 70 ? 'chart-4' : 'loss'}
            onChange={v => update('min_confidence', v)}
          />

          {/* Trade size */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="w-3.5 h-3.5 text-primary" />
              <span className="text-sm font-medium text-foreground">Trade Size (USDC)</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <NumberField
                label="Minimum Size"
                value={local.min_trade_size}
                min={Math.max(1, minimumOrderSize ?? 1)}
                max={local.max_trade_size}
                prefix="$"
                onChange={v => update('min_trade_size', v)}
              />
              <NumberField
                label="Maximum Size"
                value={local.max_trade_size}
                min={effectiveMinSize}
                max={10000}
                prefix="$"
                onChange={v => update('max_trade_size', v)}
              />
            </div>
          </div>

          {/* Stop Loss & Take Profit */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Settings2 className="w-3.5 h-3.5 text-primary" />
              <span className="text-sm font-medium text-foreground">Risk Management</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <SliderField
                label="Stop Loss"
                value={local.default_stop_loss}
                min={5}
                max={80}
                step={5}
                unit="%"
                color="loss"
                onChange={v => update('default_stop_loss', v)}
              />
              <SliderField
                label="Take Profit"
                value={local.default_take_profit}
                min={10}
                max={300}
                step={10}
                unit="%"
                color="profit"
                onChange={v => update('default_take_profit', v)}
              />
            </div>
          </div>

          {/* Position limits */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Shield className="w-3.5 h-3.5 text-primary" />
              <span className="text-sm font-medium text-foreground">Position Limits</span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <NumberField
                label="Max Open Positions"
                value={local.max_open_positions}
                min={1}
                max={50}
                onChange={v => update('max_open_positions', v)}
              />
              <NumberField
                label="Max Daily Trades"
                value={local.max_daily_trades}
                min={1}
                max={100}
                onChange={v => update('max_daily_trades', v)}
              />
              <NumberField
                label="Max Daily Loss"
                value={local.max_daily_loss}
                min={10}
                max={10000}
                prefix="$"
                onChange={v => update('max_daily_loss', v)}
              />
            </div>
          </div>

          {/* Info box */}
          <div className="flex gap-2 p-3 bg-primary/5 border border-primary/15 rounded-lg">
            <Info className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              Trade size scales linearly between min and max based on AI confidence.
              At {local.min_confidence}% confidence, minimum size is used. At 95%+, maximum size is used.
              {minimumOrderSize !== undefined && (
                <span className="block mt-1 text-primary/70">
                  Market minimum order size: ${minimumOrderSize.toFixed(2)}
                </span>
              )}
            </p>
          </div>

          {/* Save button */}
          <button
            onClick={handleSave}
            className={cn(
              'w-full h-9 rounded-md text-sm font-semibold flex items-center justify-center gap-2 transition-all',
              saved
                ? 'bg-profit/10 border border-profit/30 text-profit'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
          >
            <Save className="w-4 h-4" />
            {saved ? 'Saved!' : 'Save Settings'}
          </button>
        </div>
      </div>

      {/* ── CRYPTO UP/DOWN SETTINGS ───────────────────────────────────── */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Zap className="w-4 h-4 text-warning" />
          <h3 className="text-sm font-semibold text-foreground">Crypto ↑↓ Auto Trade</h3>
        </div>

        <div className="p-4 space-y-5">
          {/* Master switch — simpan langsung */}
          <div className="flex items-center justify-between p-3 bg-secondary/50 rounded-lg border border-border">
            <div>
              <p className="text-sm font-medium text-foreground">Auto Trade Crypto ↑↓</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Auto-execute crypto up/down trades with percentage-based SL/TP
              </p>
            </div>
            <button
              onClick={handleToggleMaster}
              className={cn(
                'relative w-11 h-6 rounded-full transition-all duration-200 shrink-0',
                cryptoSettings.auto_trade_enabled ? 'bg-warning' : 'bg-secondary border border-border'
              )}
            >
              <div className={cn(
                'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all duration-200',
                cryptoSettings.auto_trade_enabled ? 'left-[22px]' : 'left-0.5'
              )} />
            </button>
          </div>

          {/* Trade size */}
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Min Position Size (USDC)"
              value={cryptoSettings.min_position_size}
              min={1}
              max={cryptoSettings.max_position_size}
              prefix="$"
              onChange={v => updateCrypto('min_position_size', v)}
            />
            <NumberField
              label="Max Position Size (USDC)"
              value={cryptoSettings.max_position_size}
              min={cryptoSettings.min_position_size}
              max={1000}
              prefix="$"
              onChange={v => updateCrypto('max_position_size', v)}
            />
          </div>

          {/* SL/TP */}
          <div className="grid grid-cols-2 gap-3">
            <SliderField
              label="Stop Loss %"
              value={cryptoSettings.default_stop_loss_pct}
              min={10}
              max={90}
              step={5}
              unit="%"
              color="loss"
              onChange={v => updateCrypto('default_stop_loss_pct', v)}
            />
            <SliderField
              label="Take Profit %"
              value={cryptoSettings.default_take_profit_pct}
              min={20}
              max={300}
              step={10}
              unit="%"
              color="profit"
              onChange={v => updateCrypto('default_take_profit_pct', v)}
            />
          </div>

          {/* Limits */}
          <div className="grid grid-cols-3 gap-3">
            <NumberField
              label="Max Open Positions"
              value={cryptoSettings.max_open_positions}
              min={1}
              max={20}
              onChange={v => updateCrypto('max_open_positions', v)}
            />
            <NumberField
              label="Daily Loss Limit"
              value={cryptoSettings.daily_loss_limit}
              min={10}
              max={10000}
              prefix="$"
              onChange={v => updateCrypto('daily_loss_limit', v)}
            />
          </div>

          {/* Enabled Coins — simpan langsung */}
          <div>
            <label className="text-xs text-muted-foreground mb-2 block">Enabled Coins</label>
            <div className="flex flex-wrap gap-2">
              {['btc', 'eth', 'sol', 'doge', 'xrp'].map(coin => (
                <button
                  key={coin}
                  onClick={() => handleToggleCoin(coin)}
                  className={cn(
                    'px-3 py-1.5 rounded text-xs font-semibold border transition-all',
                    cryptoSettings.enabled_coins.includes(coin)
                      ? 'bg-warning/15 border-warning/30 text-warning'
                      : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {coin.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Enabled Windows — simpan langsung */}
          <div>
            <label className="text-xs text-muted-foreground mb-2 block">Enabled Windows</label>
            <div className="flex gap-2">
              {['5m', '15m'].map(w => (
                <button
                  key={w}
                  onClick={() => handleToggleWindow(w)}
                  className={cn(
                    'px-3 py-1.5 rounded text-xs font-semibold border transition-all',
                    cryptoSettings.enabled_windows.includes(w)
                      ? 'bg-warning/15 border-warning/30 text-warning'
                      : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>

          {/* Save Crypto — tetap ada untuk SL/TP, size, limits */}
          <button
            onClick={handleCryptoSave}
            className={cn(
              'w-full h-9 rounded-md text-sm font-semibold flex items-center justify-center gap-2 transition-all',
              cryptoSaved
                ? 'bg-profit/10 border border-profit/30 text-profit'
                : 'bg-warning text-warning-foreground hover:bg-warning/90'
            )}
          >
            <Save className="w-4 h-4" />
            {cryptoSaved ? 'Saved!' : 'Save Crypto Settings'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SliderField({
  icon: Icon,
  label,
  description,
  value,
  min,
  max,
  step = 1,
  unit = '',
  color = 'primary',
  onChange,
}: {
  icon?: React.ElementType
  label: string
  description?: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  color?: string
  onChange: (v: number) => void
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          {Icon && <Icon className="w-3.5 h-3.5 text-muted-foreground" />}
          <span className="text-xs font-medium text-foreground">{label}</span>
        </div>
        <span className={cn(
          'text-sm font-mono font-bold',
          color === 'profit' ? 'text-profit' :
          color === 'loss' ? 'text-loss' :
          color === 'chart-4' ? 'text-chart-4' : 'text-primary'
        )}>{value}{unit}</span>
      </div>
      {description && (
        <p className="text-xs text-muted-foreground mb-1.5">{description}</p>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full h-1.5 bg-secondary rounded-full appearance-none cursor-pointer accent-primary"
      />
      <div className="flex justify-between mt-0.5">
        <span className="text-xs text-muted-foreground">{min}{unit}</span>
        <span className="text-xs text-muted-foreground">{max}{unit}</span>
      </div>
    </div>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  prefix,
  onChange,
}: {
  label: string
  value: number
  min?: number
  max?: number
  prefix?: string
  onChange: (v: number) => void
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1 block">{label}</label>
      <div className="relative">
        {prefix && (
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {prefix}
          </span>
        )}
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          className={cn(
            'w-full h-8 bg-secondary border border-border rounded text-sm font-mono text-foreground outline-none focus:border-primary transition-colors',
            prefix ? 'pl-5 pr-2' : 'px-2'
          )}
        />
      </div>
    </div>
  )
}
