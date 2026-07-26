import { splitAutomationCronExpressionFields } from '../../automations/cron-validation'

export type AutomationCadence =
  | 'every-15-minutes'
  | 'hourly'
  | 'daily'
  | 'weekdays'
  | 'weekly'

export interface AutomationScheduleState {
  cadence: AutomationCadence
  minute: string
  time: string
  weekday: string
}

export const DEFAULT_AUTOMATION_SCHEDULE: AutomationScheduleState = {
  cadence: 'daily',
  minute: '0',
  time: '09:00',
  weekday: '1',
}

export const AUTOMATION_CADENCE_OPTIONS: Array<{
  value: AutomationCadence
  label: string
}> = [
  { value: 'every-15-minutes', label: 'Every 15 minutes' },
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Every weekday' },
  { value: 'weekly', label: 'Every week' },
]

export const AUTOMATION_MINUTE_OPTIONS = ['0', '15', '30', '45'].map((value) => ({
  value,
  label: `:${value.padStart(2, '0')}`,
}))

export const AUTOMATION_WEEKDAY_OPTIONS = [
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
] as const

export const AUTOMATION_TIME_OPTIONS = Array.from({ length: 96 }, (_, index) => {
  const minutesFromMidnight = index * 15
  const hours = Math.floor(minutesFromMidnight / 60)
  const minutes = minutesFromMidnight % 60
  const value = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
  return {
    value,
    label: value,
  }
})

function parseTimeParts(value: string): { hour: string; minute: string } {
  const [rawHour = '00', rawMinute = '00'] = value.split(':')
  const hour = /^\d+$/.test(rawHour) ? rawHour : '00'
  const minute = /^\d+$/.test(rawMinute) ? rawMinute : '00'
  return {
    hour,
    minute,
  }
}

export function buildAutomationSchedule(state: AutomationScheduleState): string {
  if (state.cadence === 'every-15-minutes') {
    return '*/15 * * * *'
  }

  if (state.cadence === 'hourly') {
    return `${state.minute} * * * *`
  }

  const { hour, minute } = parseTimeParts(state.time)

  if (state.cadence === 'daily') {
    return `${minute} ${hour} * * *`
  }

  if (state.cadence === 'weekdays') {
    return `${minute} ${hour} * * 1-5`
  }

  return `${minute} ${hour} * * ${state.weekday}`
}

function lookupWeekday(dayOfWeek: string): string | null {
  const normalized = dayOfWeek === '7' ? '0' : dayOfWeek
  const option = AUTOMATION_WEEKDAY_OPTIONS.find((entry) => entry.value === normalized)
  return option?.label ?? null
}

function isCronNumber(value: string, max: number): boolean {
  if (!/^\d+$/.test(value)) {
    return false
  }
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= max
}

function formatCronTime(hourValue: string, minuteValue: string): string | null {
  if (!isCronNumber(hourValue, 23) || !isCronNumber(minuteValue, 59)) {
    return null
  }

  const hour = Number(hourValue)
  const minute = Number(minuteValue)
  const period = hour >= 12 ? 'PM' : 'AM'
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  return `${hour12}:${minute.toString().padStart(2, '0')} ${period}`
}

function describeCronDay(dayOfWeek: string): string | null {
  if (dayOfWeek === '*') {
    return 'Every day'
  }
  if (dayOfWeek === '1-5' || dayOfWeek === 'MON-FRI') {
    return 'Every weekday'
  }
  const weekday = lookupWeekday(dayOfWeek)
  if (weekday) {
    return `Every ${weekday}`
  }
  if (dayOfWeek.includes(',')) {
    const labels = dayOfWeek.split(',').map((day) => lookupWeekday(day.trim())).filter(Boolean)
    if (labels.length === dayOfWeek.split(',').length) {
      return `Every ${labels.join(', ')}`
    }
  }
  return null
}

export function describeAutomationSchedule(expression: string): string {
  const parts = splitAutomationCronExpressionFields(expression)
  if (parts.length !== 5) {
    return expression
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return expression
  }

  if (hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    if (minute === '*') {
      return 'Every minute'
    }
    const intervalMatch = /^\*\/(\d+)$/.exec(minute)
    if (intervalMatch) {
      const interval = Number(intervalMatch[1])
      if (interval > 0) {
        return interval === 1 ? 'Every minute' : `Every ${interval} minutes`
      }
    }
    if (isCronNumber(minute, 59)) {
      return minute === '0' ? 'Hourly' : `Hourly at :${minute.padStart(2, '0')}`
    }
  }

  if (dayOfMonth === '*' && month === '*') {
    const dayLabel = describeCronDay(dayOfWeek.toUpperCase())
    const timeLabel = formatCronTime(hour, minute)
    if (dayLabel && timeLabel) {
      return `${dayLabel} · ${timeLabel}`
    }
  }

  return expression
}
