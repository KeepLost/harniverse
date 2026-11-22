/** Process streams used by the runner; tests replace them with captures. */

interface TextOutput {
  write(value: string): unknown
}

export const internals: { stdout: TextOutput; stderr: TextOutput } = {
  stdout: process.stdout,
  stderr: process.stderr,
}
