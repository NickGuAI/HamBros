export function splitAutomationCronExpressionFields(expression: string): string[] {
  const prepared = expression.replace(/\s{2,}/g, ' ').trim()
  return prepared ? prepared.split(' ') : []
}

/**
 * Browser-safe draft readiness only. The server's node-cron validator remains
 * authoritative, so this guard must not impose an upper field-count bound or
 * attempt to duplicate cron semantics.
 * TODO(provider-gap): Pinned node-cron 4.2.1 currently rejects the documented
 * nicknames (@yearly, @annually, @monthly, @weekly, @daily, @midnight,
 * @hourly) from the Nicknames section at https://nodecron.com/cron-syntax.html.
 * Keep browser readiness aligned until the pinned provider changes.
 */
export function isAutomationCronExpressionComplete(expression: string): boolean {
  const parts = splitAutomationCronExpressionFields(expression)
  return parts.length >= 5 && parts.every((part) => part.length > 0)
}
