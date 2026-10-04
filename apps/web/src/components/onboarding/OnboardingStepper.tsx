/**
 * The onboarding progress indicator (T03).
 *
 * Purely presentational: it takes the current index and the names, and draws them. All the
 * state lives in the page, which is what lets the wizard skip a step (avatar, links) without
 * the stepper needing to know that skipping is allowed.
 *
 * Accessible as an ordered list rather than a row of decorative dots: a member using a screen
 * reader should be able to hear "step 2 of 5, Avatar" and know where they are.
 */
export interface OnboardingStepperProps {
  readonly steps: readonly string[]
  readonly current: number
}

export function OnboardingStepper({ steps, current }: OnboardingStepperProps) {
  return (
    <nav aria-label="Onboarding progress">
      <ol className="flex flex-wrap items-center gap-2">
        {steps.map((name, index) => {
          const state = index < current ? 'done' : index === current ? 'current' : 'upcoming'

          return (
            <li key={name} className="flex items-center gap-2">
              <span
                aria-current={state === 'current' ? 'step' : undefined}
                className={[
                  'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium',
                  state === 'done'
                    ? 'border-positive/25 bg-positive/10 text-positive'
                    : state === 'current'
                      ? 'border-brand/25 bg-brand-soft text-brand'
                      : 'border-border bg-surface-muted text-ink-subtle',
                ].join(' ')}
              >
                <span aria-hidden="true">{index + 1}</span>
                {name}
                <span className="sr-only">
                  {state === 'done' ? ' (completed)' : state === 'current' ? ' (current step)' : ''}
                </span>
              </span>

              {index < steps.length - 1 ? (
                <span aria-hidden="true" className="text-ink-subtle">
                  /
                </span>
              ) : null}
            </li>
          )
        })}
      </ol>

      <p className="mt-2 text-xs text-ink-subtle">
        Step {current + 1} of {steps.length}
      </p>
    </nav>
  )
}