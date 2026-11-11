const percent = new Intl.NumberFormat("en", { maximumFractionDigits: 3 });
const responseTime = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

export function formatAvailability(value: number | null): string {
  if (value === null) return "Not enough data";
  if (value < 100 && value >= 99.9995) return ">99.999%";
  return `${percent.format(value)}%`;
}

export function formatCoverage(value: number): string {
  return `${responseTime.format(value * 100)}%`;
}

export function formatResponseTime(value: number | null): string {
  return value === null ? "No data" : `${responseTime.format(value)} ms`;
}
