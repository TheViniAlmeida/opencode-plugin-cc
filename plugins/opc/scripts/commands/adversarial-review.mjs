// /opc:adversarial-review: mesmo fluxo de /opc:review com prompt adversarial e foco livre.
import { runReviewCommand } from './review.mjs';

export function run(ctx, argv) {
  return runReviewCommand(ctx, argv, { variant: 'adversarial' });
}
