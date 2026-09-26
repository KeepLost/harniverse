/** Shared statistics and memory observations for coding-agent benchmarks. */

export interface ProcessMemorySample {
  readonly heapUsedMb: number
  readonly rssMb: number
  readonly externalMb: number
  readonly arrayBuffersMb: number
  readonly peakRssMb: number
}

export function rounded(value: number, digits = 3): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('cannot calculate a median without samples')
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

export function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) throw new Error('cannot calculate a percentile without samples')
  if (percentileValue < 0 || percentileValue > 1) throw new Error('percentile must be between 0 and 1')
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)] as number
}

export function memorySample(): ProcessMemorySample {
  const memory = process.memoryUsage()
  return {
    heapUsedMb: rounded(memory.heapUsed / 1_048_576),
    rssMb: rounded(memory.rss / 1_048_576),
    externalMb: rounded(memory.external / 1_048_576),
    arrayBuffersMb: rounded(memory.arrayBuffers / 1_048_576),
    peakRssMb: rounded(process.resourceUsage().maxRSS / 1_024),
  }
}

export function collectGarbage(): void {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
  gc?.()
}
