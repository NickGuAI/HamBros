import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

interface EconomyPoint {
  time: string
  totalCost: number
}

interface EconomyScreenProps {
  history: EconomyPoint[]
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`
}

export function EconomyScreen({ history }: EconomyScreenProps) {
  const latest = history.length > 0 ? history[history.length - 1].totalCost : 0

  return (
    <section className="h-[100dvh] w-full overflow-hidden bg-zinc-950 text-white">
      <header className="border-b border-white/10 px-4 py-3">
        <h1 className="font-mono text-xs uppercase tracking-[0.12em] text-white/85">economy</h1>
        <p className="mt-1 font-mono text-[11px] text-white/70">total spend {formatUsd(latest)}</p>
      </header>

      <div className="h-[calc(100dvh-3.25rem)] p-4">
        <div className="h-full rounded-lg border border-white/15 bg-black/35 p-3">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={history} margin={{ top: 16, right: 16, bottom: 8, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.15)" />
              <XAxis
                dataKey="time"
                tick={{ fill: 'rgba(255,255,255,0.7)', fontSize: 11 }}
                axisLine={{ stroke: 'rgba(255,255,255,0.25)' }}
                tickLine={{ stroke: 'rgba(255,255,255,0.25)' }}
              />
              <YAxis
                tick={{ fill: 'rgba(255,255,255,0.7)', fontSize: 11 }}
                axisLine={{ stroke: 'rgba(255,255,255,0.25)' }}
                tickLine={{ stroke: 'rgba(255,255,255,0.25)' }}
                tickFormatter={(value) => `$${Number(value).toFixed(2)}`}
              />
              <Tooltip
                formatter={(value) => formatUsd(Number(value))}
                contentStyle={{
                  backgroundColor: 'rgba(10, 10, 10, 0.95)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: 8,
                }}
                labelStyle={{ color: 'rgba(255,255,255,0.8)' }}
              />
              <Area
                type="monotone"
                dataKey="totalCost"
                stroke="#22c55e"
                fill="#22c55e"
                fillOpacity={0.25}
                strokeWidth={2}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  )
}
