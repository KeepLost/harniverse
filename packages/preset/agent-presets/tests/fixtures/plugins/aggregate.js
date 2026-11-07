export const name = 'aggregate'

export function apply() {
  throw Object.assign(
    new AggregateError([new Error('member one'), new Error('member two')], 'wrapped failure'),
  )
}
