const Limits = require('./TaggingLimits');

function createRequestBudget(limit = Limits.networkPerOperation) {
  if (!Number.isInteger(limit) || limit < 0) throw new TypeError('Request budget must be a non-negative integer');
  return {limit, used:0};
}

function spendRequest(budget, stage) {
  if (budget.used >= budget.limit) {
    const error = new Error('The catalog request budget for this operation was exhausted');
    error.code = 'request-budget-exhausted';
    error.budget = {limit:budget.limit, used:budget.used, stage};
    throw error;
  }
  budget.used++;
}

module.exports = {createRequestBudget, spendRequest};
