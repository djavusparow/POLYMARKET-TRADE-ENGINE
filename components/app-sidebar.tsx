'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, TrendingUp, BrainCircuit, Settings,
  History, Wallet, Zap, Activity, Wifi, WifiOff, BarChart2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const navItems = [
  { href: '/',        label: 'Dashboard',      icon: LayoutDashboard },
  { href: '/crypto',  label: 'Crypto ↑↓',      icon: BarChart2,       highlight: true },
  { href: '/markets', label: 'Markets',         icon: TrendingUp },
  { href: '/signals', label: 'AI Signals',      icon: BrainCircuit },
  { href: '/portfolio',label: 'Portfolio',      icon: Wallet },
  { href: '/history', label: 'Trade History',   icon: History },
  { href: '/settings',label: 'Settings',        icon: Settings },
]

interface AppSidebarProps {
  autoTradeEnabled?: boolean
  scanning?:         boolean
  connected?:        boolean
}

export function AppSidebar({
  autoTradeEnabled = false,
  scanning         = false,
  connected        = true,
}: AppSidebarProps) {
  const pathname = usePathname()

  return (
    <aside className="fixed left-0 top-0 h-full w-16 lg:w-56 bg-sidebar border-r border-sidebar-border flex flex-col z-40">
      {/* Logo */}
      <div className="h-14 flex items-center px-3 lg:px-4 border-b border-sidebar-border shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
            <Zap className="w-4 h-4 text-primary-foreground" />
          </div>
          <span className="hidden lg:block font-bold text-sm text-foreground tracking-tight">
            Polytrade <span className="text-primary">AI</span>
          </span>
        </div>
      </div>

      {/* Status */}
      <div className="px-3 lg:px-4 py-3 border-b border-sidebar-border space-y-1">
        <div className="flex items-center gap-2">
          <div className={cn(
            'w-2 h-2 rounded-full shrink-0',
            autoTradeEnabled ? 'bg-profit animate-pulse' : 'bg-muted-foreground'
          )} />
          <span className={cn(
            'hidden lg:block text-xs font-medium',
            autoTradeEnabled ? 'text-profit' : 'text-muted-foreground'
          )}>
            {autoTradeEnabled ? 'Auto Trade: ON' : 'Auto Trade: OFF'}
          </span>
        </div>

        {scanning && (
          <div className="hidden lg:flex items-center gap-2">
            <Activity className="w-3 h-3 text-primary animate-pulse" />
            <span className="text-xs text-primary">Scanning...</span>
          </div>
        )}

        <div className="hidden lg:flex items-center gap-2">
          {connected
            ? <><Wifi className="w-3.5 h-3.5 text-profit" /><span className="text-xs text-muted-foreground">Connected</span><div className="w-1 h-1 rounded-full bg-profit animate-pulse" /></>
            : <><WifiOff className="w-3.5 h-3.5 text-loss" /><span className="text-xs text-muted-foreground">Disconnected</span></>}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-2 overflow-y-auto">
        {navItems.map((item) => {
          const Icon   = item.icon
          const active = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 mx-2 px-2 lg:px-3 py-2.5 rounded-md text-sm font-medium transition-all',
                active
                  ? 'bg-primary/10 text-primary'
                  : item.highlight
                  ? 'text-profit/80 hover:text-profit hover:bg-profit/10'
                  : 'text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent'
              )}
            >
              <Icon className={cn('w-4 h-4 shrink-0', active ? 'text-primary' : item.highlight && !active ? 'text-profit/80' : '')} />
              <span className="hidden lg:block">{item.label}</span>
              {item.highlight && !active && (
                <span className="hidden lg:block ml-auto text-xs bg-profit/20 text-profit px-1.5 py-0.5 rounded font-mono">
                  LIVE
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="px-3 lg:px-4 py-3 border-t border-sidebar-border">
        <p className="hidden lg:block text-xs text-muted-foreground text-center">Polytrade AI v2.0</p>
      </div>
    </aside>
  )
}
