/** Parses durations such as "90s", "15m", "4h", "1d" (or a bare number of seconds). Returns seconds, or null. */
export function parseDuration(input: string): number | null {
  const match = /^(\d+)\s*([smhd]?)$/.exec(input.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2] || 's';
  const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return value * multiplier;
}
