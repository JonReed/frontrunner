import {
  emitEvaluationExecutionResult,
  evaluationExecutionResult,
} from '../../src/evaluate/execution-result.mjs';

emitEvaluationExecutionResult(evaluationExecutionResult({
  status: 'succeeded',
  usage: {
    prompt_tokens: 12,
    completion_tokens: 3,
    total_tokens: 15,
    cached_tokens: 4,
  },
}));
