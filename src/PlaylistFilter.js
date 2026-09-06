// Safe, JavaScript-like playlist-filter expressions.
//
// JSEP only parses the expression. This module validates and interprets the
// resulting AST itself; user text is never handed to eval(), Function(), or a
// VM. Calls and property access are consequently limited to the data and pure
// operations explicitly listed below.
const jsepModule = require('jsep');
const arrowPluginModule = require('@jsep-plugin/arrow');
const commentPluginModule = require('@jsep-plugin/comment');
const numbersPluginModule = require('@jsep-plugin/numbers');
const objectPluginModule = require('@jsep-plugin/object');
const spreadPluginModule = require('@jsep-plugin/spread');
const templatePluginModule = require('@jsep-plugin/template');
const ternaryPluginModule = require('@jsep-plugin/ternary');

const jsep = jsepModule.default || jsepModule;
const arrowPlugin = arrowPluginModule.default || arrowPluginModule;
const commentPlugin = commentPluginModule.default || commentPluginModule;
const numbersPlugin = numbersPluginModule.default || numbersPluginModule;
const objectPlugin = objectPluginModule.default || objectPluginModule;
const spreadPlugin = spreadPluginModule.default || spreadPluginModule;
const templatePlugin = templatePluginModule.default || templatePluginModule;
const ternaryPlugin = ternaryPluginModule.default || ternaryPluginModule;

jsep.plugins.register(
  commentPlugin,
  numbersPlugin,
  objectPlugin,
  spreadPlugin,
  templatePlugin,
  arrowPlugin,
  ternaryPlugin
);
jsep.addUnaryOp('typeof');
jsep.addBinaryOp('in', 7);
jsep.addLiteral('undefined', undefined);
jsep.addLiteral('NaN', NaN);
jsep.addLiteral('Infinity', Infinity);

const MAX_SOURCE_LENGTH = 8192;
const MAX_AST_NODES = 1024;
const MAX_AST_DEPTH = 64;
const MAX_ARGUMENTS = 32;
const MAX_ARRAY_LENGTH = 10000;
const MAX_STRING_LENGTH = 100000;
const MAX_OPERATIONS = 20000;
const MAX_CACHE_SIZE = 200;

const BLOCKED_PROPERTIES = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'arguments',
  'callee',
  'caller',
  'constructor',
  'prototype'
]);

const GLOBAL_FUNCTIONS = new Set([
  'Boolean',
  'Number',
  'String',
  'ageInDays',
  'between',
  'clamp',
  'daysAgo',
  'defined',
  'empty',
  'hoursAgo',
  'isFinite',
  'isNaN',
  'now',
  'parseFloat',
  'parseInt',
  'weeksAgo',
  'yearsAgo'
]);

const MATH_METHODS = new Set([
  'abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh',
  'cbrt', 'ceil', 'clz32', 'cos', 'cosh', 'exp', 'expm1', 'floor',
  'fround', 'hypot', 'imul', 'log', 'log10', 'log1p', 'log2', 'max',
  'min', 'pow', 'round', 'sign', 'sin', 'sinh', 'sqrt', 'tan', 'tanh',
  'trunc'
]);
const MATH_CONSTANTS = new Set([
  'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'PI', 'SQRT1_2', 'SQRT2'
]);
const NUMBER_METHODS = new Set([
  'isFinite', 'isInteger', 'isNaN', 'isSafeInteger', 'parseFloat', 'parseInt'
]);
const STRING_STATIC_METHODS = new Set(['fromCharCode', 'fromCodePoint']);
const ARRAY_STATIC_METHODS = new Set(['isArray']);
const OBJECT_METHODS = new Set(['entries', 'hasOwn', 'is', 'keys', 'values']);
const DATE_METHODS = new Set(['now']);

const STRING_METHODS = new Set([
  'at', 'charAt', 'charCodeAt', 'codePointAt', 'concat', 'endsWith',
  'includes', 'indexOf', 'lastIndexOf', 'localeCompare', 'normalize',
  'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll', 'slice',
  'split', 'startsWith', 'substr', 'substring', 'toLowerCase',
  'toString', 'toUpperCase', 'trim', 'trimEnd', 'trimStart', 'valueOf'
]);
const NUMBER_INSTANCE_METHODS = new Set([
  'toExponential', 'toFixed', 'toPrecision', 'toString', 'valueOf'
]);
const BOOLEAN_INSTANCE_METHODS = new Set(['toString', 'valueOf']);
const ARRAY_METHODS = new Set([
  'at', 'concat', 'entries', 'every', 'filter', 'find', 'findIndex',
  'flat', 'flatMap', 'includes', 'indexOf', 'join', 'keys', 'lastIndexOf',
  'map', 'reduce', 'reduceRight', 'slice', 'some', 'toString', 'values'
]);
const CALLBACK_ARRAY_METHODS = new Set([
  'every', 'filter', 'find', 'findIndex', 'flatMap', 'map', 'reduce',
  'reduceRight', 'some'
]);
const INSTANCE_METHODS = new Set([
  ...STRING_METHODS,
  ...NUMBER_INSTANCE_METHODS,
  ...BOOLEAN_INSTANCE_METHODS,
  ...ARRAY_METHODS
]);

const NAMESPACE_METHODS = Object.freeze({
  Array: ARRAY_STATIC_METHODS,
  Date: DATE_METHODS,
  Math: MATH_METHODS,
  Number: NUMBER_METHODS,
  Object: OBJECT_METHODS,
  String: STRING_STATIC_METHODS
});
const NAMESPACE_NAMES = new Set(Object.keys(NAMESPACE_METHODS));

const ALLOWED_UNARY_OPERATORS = new Set(['!', '+', '-', '~', 'typeof']);
const ALLOWED_BINARY_OPERATORS = new Set([
  '!=', '!==', '%', '&', '&&', '*', '**', '+', '-', '/', '<', '<<',
  '<=', '==', '===', '>', '>=', '>>', '>>>', '??', '^', 'in', '|', '||'
]);

const CALLBACK_MARKER = Symbol('MyndaPlaylistFilterCallback');
const NAMESPACE_MARKER = Symbol('MyndaPlaylistFilterNamespace');
const namespaceTokens = Object.freeze(Object.keys(NAMESPACE_METHODS).reduce((tokens, name) => {
  tokens[name] = Object.freeze({marker: NAMESPACE_MARKER, name: name});
  return tokens;
}, Object.create(null)));

const compiledCache = new Map();

const PLAYLIST_FILTER_REFERENCE = Object.freeze({
  globalFunctions: Object.freeze(Array.from(GLOBAL_FUNCTIONS).sort()),
  namespaces: Object.freeze(Object.keys(NAMESPACE_METHODS).reduce((result, name) => {
    result[name] = Object.freeze(Array.from(NAMESPACE_METHODS[name]).sort());
    return result;
  }, {})),
  mathConstants: Object.freeze(Array.from(MATH_CONSTANTS).sort()),
  stringMethods: Object.freeze(Array.from(STRING_METHODS).sort()),
  numberMethods: Object.freeze(Array.from(NUMBER_INSTANCE_METHODS).sort()),
  arrayMethods: Object.freeze(Array.from(ARRAY_METHODS).sort()),
  operators: Object.freeze(Array.from(ALLOWED_BINARY_OPERATORS).sort())
});

class PlaylistFilterError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'PlaylistFilterError';
    this.code = code || 'FILTER_ERROR';
    if (details && Number.isInteger(details.index)) this.index = details.index;
    if (details && details.nodeType) this.nodeType = details.nodeType;
  }
}

function filterError(message, code, details) {
  return new PlaylistFilterError(message, code, details);
}

function assertSource(source) {
  if (typeof source !== 'string') {
    throw filterError('A playlist filter must be text.', 'INVALID_SOURCE');
  }
  if (source.trim() === '') {
    throw filterError('A playlist filter cannot be empty. Use false to match nothing.', 'EMPTY_FILTER');
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    throw filterError(
      `The playlist filter is too long (maximum ${MAX_SOURCE_LENGTH} characters).`,
      'FILTER_TOO_LONG'
    );
  }
}

function parseFilter(source) {
  assertSource(source);
  try {
    return jsep(source);
  } catch (error) {
    const index = Number.isInteger(error && error.index) ? error.index : undefined;
    throw filterError(`Could not parse the playlist filter: ${error.message}`, 'PARSE_ERROR', {index: index});
  }
}

function staticPropertyExpression(node) {
  if (!node) return null;
  if (node.type === 'Literal' &&
      (typeof node.value === 'string' || typeof node.value === 'number' || typeof node.value === 'boolean')) {
    return String(node.value);
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticPropertyExpression(node.left);
    const right = staticPropertyExpression(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function staticMemberName(member) {
  if (!member || member.type !== 'MemberExpression') return null;
  if (!member.computed && member.property && member.property.type === 'Identifier') {
    return member.property.name;
  }
  if (member.computed) return staticPropertyExpression(member.property);
  return null;
}

function rejectBlockedProperty(property) {
  if (BLOCKED_PROPERTIES.has(String(property))) {
    throw filterError(`Property "${property}" is not available in playlist filters.`, 'BLOCKED_PROPERTY');
  }
}

function validateFilterAst(ast) {
  const state = {nodes: 0};
  validateNode(ast, state, [new Set(['video'])], 0, null);
}

function validateNode(node, state, scopes, depth, context) {
  if (!node || typeof node !== 'object') {
    throw filterError('The playlist filter contains an invalid expression.', 'INVALID_AST');
  }
  state.nodes += 1;
  if (state.nodes > MAX_AST_NODES) {
    throw filterError(`The playlist filter is too complex (maximum ${MAX_AST_NODES} expressions).`, 'FILTER_TOO_COMPLEX');
  }
  if (depth > MAX_AST_DEPTH) {
    throw filterError(`The playlist filter is nested too deeply (maximum ${MAX_AST_DEPTH} levels).`, 'FILTER_TOO_DEEP');
  }

  const next = (child, childContext) => validateNode(child, state, scopes, depth + 1, childContext || null);

  switch (node.type) {
    case 'Literal':
      if (node.regex || node.value instanceof RegExp) {
        throw filterError('Regular expressions are not supported yet.', 'REGEX_NOT_SUPPORTED');
      }
      if (node.value !== null && !['string', 'number', 'boolean', 'undefined'].includes(typeof node.value)) {
        throw filterError('Only string, number, boolean, null, and undefined literals are supported.', 'UNSUPPORTED_LITERAL');
      }
      if (typeof node.value === 'string' && node.value.length > MAX_STRING_LENGTH) {
        throw filterError('A string literal in the playlist filter is too long.', 'STRING_TOO_LONG');
      }
      return;

    case 'Identifier': {
      const isScoped = scopes.some(scope => scope.has(node.name));
      if (isScoped) return;
      if (context === 'direct-call' && GLOBAL_FUNCTIONS.has(node.name)) return;
      if (context === 'namespace' && NAMESPACE_NAMES.has(node.name)) return;
      throw filterError(`Unknown name "${node.name}". Playlist filters can only use video, callback parameters, and documented functions.`, 'UNKNOWN_IDENTIFIER');
    }

    case 'UnaryExpression':
      if (!ALLOWED_UNARY_OPERATORS.has(node.operator)) {
        throw filterError(`Unary operator "${node.operator}" is not supported.`, 'UNSUPPORTED_OPERATOR');
      }
      next(node.argument);
      return;

    case 'BinaryExpression':
    case 'LogicalExpression':
      if (!ALLOWED_BINARY_OPERATORS.has(node.operator)) {
        throw filterError(`Operator "${node.operator}" is not supported.`, 'UNSUPPORTED_OPERATOR');
      }
      next(node.left);
      next(node.right);
      return;

    case 'ConditionalExpression':
      next(node.test);
      next(node.consequent);
      next(node.alternate);
      return;

    case 'ArrayExpression':
      if (node.elements.length > MAX_ARRAY_LENGTH) {
        throw filterError(`Array literals may contain at most ${MAX_ARRAY_LENGTH} items.`, 'ARRAY_TOO_LONG');
      }
      node.elements.forEach(element => {
        if (element) next(element, element.type === 'SpreadElement' ? 'array-spread' : null);
      });
      return;

    case 'ObjectExpression':
      if (node.properties.length > MAX_ARRAY_LENGTH) {
        throw filterError(`Object literals may contain at most ${MAX_ARRAY_LENGTH} properties.`, 'OBJECT_TOO_LARGE');
      }
      node.properties.forEach(property => {
        if (property.type === 'SpreadElement') {
          next(property, 'object-spread');
          return;
        }
        if (property.type !== 'Property') {
          throw filterError('This kind of object property is not supported.', 'UNSUPPORTED_OBJECT_PROPERTY');
        }
        let propertyName = null;
        if (property.computed) {
          propertyName = staticPropertyExpression(property.key);
          next(property.key);
        } else if (property.key.type === 'Identifier') {
          propertyName = property.key.name;
        } else if (property.key.type === 'Literal') {
          propertyName = String(property.key.value);
        } else {
          throw filterError('Object property names must be text, numbers, or computed primitive values.', 'INVALID_OBJECT_PROPERTY');
        }
        if (propertyName !== null) rejectBlockedProperty(propertyName);
        next(property.value);
      });
      return;

    case 'TemplateLiteral': {
      if ((node.expressions || []).length !== Math.max(0, (node.quasis || []).length - 1)) {
        throw filterError('Each template-string placeholder must contain one expression.', 'INVALID_TEMPLATE');
      }
      const quasiLength = (node.quasis || []).reduce((length, quasi) => {
        return length + String(quasi && quasi.value ? quasi.value.cooked : '').length;
      }, 0);
      if (quasiLength > MAX_STRING_LENGTH) {
        throw filterError('A template string in the playlist filter is too long.', 'STRING_TOO_LONG');
      }
      (node.expressions || []).forEach(expression => next(expression));
      return;
    }

    case 'SpreadElement':
      if (!['array-spread', 'call-spread', 'object-spread'].includes(context)) {
        throw filterError('Spread syntax may only be used in arrays, objects, and function arguments.', 'UNSUPPORTED_SPREAD');
      }
      next(node.argument);
      return;

    case 'MemberExpression': {
      const property = staticMemberName(node);
      if (property !== null) rejectBlockedProperty(property);

      if (node.object && node.object.type === 'Identifier' && NAMESPACE_NAMES.has(node.object.name)) {
        validateNode(node.object, state, scopes, depth + 1, 'namespace');
        if (property === null) {
          throw filterError('Namespace properties must use a literal name.', 'DYNAMIC_NAMESPACE_PROPERTY');
        }
        if (node.object.name === 'Math' && MATH_CONSTANTS.has(property)) return;
        throw filterError(`${node.object.name}.${property} is a function and must be called, or is not supported.`, 'UNSUPPORTED_NAMESPACE_PROPERTY');
      }

      next(node.object);
      if (node.computed) next(node.property);
      return;
    }

    case 'CallExpression':
      validateCall(node, state, scopes, depth);
      return;

    case 'ArrowFunctionExpression':
      if (context !== 'array-callback') {
        throw filterError('Arrow functions may only be used as callbacks to documented array methods.', 'UNSUPPORTED_ARROW_FUNCTION');
      }
      validateArrow(node, state, scopes, depth);
      return;

    case 'ThisExpression':
      throw filterError('The "this" value is not available in playlist filters.', 'THIS_NOT_AVAILABLE');

    case 'Compound':
    case 'SequenceExpression':
      throw filterError('A playlist filter must be one expression; statements and comma expressions are not supported.', 'MULTIPLE_EXPRESSIONS');

    default:
      throw filterError(`Expression type "${node.type}" is not supported in playlist filters.`, 'UNSUPPORTED_EXPRESSION', {nodeType: node.type});
  }
}

function validateCall(node, state, scopes, depth) {
  if (!Array.isArray(node.arguments) || node.arguments.length > MAX_ARGUMENTS) {
    throw filterError(`Function calls may have at most ${MAX_ARGUMENTS} arguments.`, 'TOO_MANY_ARGUMENTS');
  }

  let methodName = null;
  let callbacksAllowed = false;

  if (node.callee.type === 'Identifier') {
    validateNode(node.callee, state, scopes, depth + 1, 'direct-call');
  } else if (node.callee.type === 'MemberExpression') {
    methodName = staticMemberName(node.callee);
    if (methodName === null) {
      throw filterError('Method names must be written literally, such as video.tags.includes(...).', 'DYNAMIC_METHOD');
    }
    rejectBlockedProperty(methodName);

    const receiver = node.callee.object;
    if (receiver.type === 'Identifier' && NAMESPACE_NAMES.has(receiver.name)) {
      validateNode(receiver, state, scopes, depth + 1, 'namespace');
      if (!NAMESPACE_METHODS[receiver.name].has(methodName)) {
        throw filterError(`${receiver.name}.${methodName}() is not available in playlist filters.`, 'UNSUPPORTED_FUNCTION');
      }
    } else {
      validateNode(receiver, state, scopes, depth + 1, null);
      if (!INSTANCE_METHODS.has(methodName)) {
        throw filterError(`Method .${methodName}() is not available in playlist filters.`, 'UNSUPPORTED_METHOD');
      }
      callbacksAllowed = CALLBACK_ARRAY_METHODS.has(methodName);
    }
  } else {
    throw filterError('Only documented functions and methods can be called.', 'UNSUPPORTED_CALL');
  }

  node.arguments.forEach((argument, index) => {
    if (argument && argument.type === 'SpreadElement') {
      validateNode(argument, state, scopes, depth + 1, 'call-spread');
      return;
    }
    const isArrow = argument && argument.type === 'ArrowFunctionExpression';
    if (isArrow && (!callbacksAllowed || index !== 0)) {
      throw filterError('Arrow functions may only be passed to documented array callback methods.', 'UNSUPPORTED_ARROW_FUNCTION');
    }
    validateNode(argument, state, scopes, depth + 1, isArrow ? 'array-callback' : null);
  });
}

function validateArrow(node, state, scopes, depth) {
  const params = node.params || [];
  if (params.length > 4) {
    throw filterError('Array callbacks may declare at most four parameters.', 'TOO_MANY_CALLBACK_PARAMETERS');
  }
  const names = new Set();
  params.forEach(param => {
    if (!param || param.type !== 'Identifier') {
      throw filterError('Array callback parameters must be simple names.', 'INVALID_CALLBACK_PARAMETER');
    }
    if (param.name === 'video' || GLOBAL_FUNCTIONS.has(param.name) || NAMESPACE_NAMES.has(param.name)) {
      throw filterError(`Callback parameter "${param.name}" is reserved.`, 'RESERVED_CALLBACK_PARAMETER');
    }
    if (names.has(param.name)) {
      throw filterError(`Callback parameter "${param.name}" is duplicated.`, 'DUPLICATE_CALLBACK_PARAMETER');
    }
    names.add(param.name);
  });

  scopes.push(names);
  validateNode(node.body, state, scopes, depth + 1, null);
  scopes.pop();
}

function freezeAst(node) {
  if (!node || typeof node !== 'object' || Object.isFrozen(node)) return node;
  Object.keys(node).forEach(key => freezeAst(node[key]));
  return Object.freeze(node);
}

function trimCache() {
  while (compiledCache.size >= MAX_CACHE_SIZE) {
    const firstKey = compiledCache.keys().next().value;
    compiledCache.delete(firstKey);
  }
}

function createPlaylistFilterContext(nowMilliseconds) {
  const value = nowMilliseconds === undefined ? Date.now() : Number(nowMilliseconds);
  if (!Number.isFinite(value)) {
    throw filterError('The playlist-filter clock must be a finite millisecond timestamp.', 'INVALID_CLOCK');
  }
  return Object.freeze({nowMilliseconds: value});
}

function compilePlaylistFilter(source) {
  assertSource(source);
  const cached = compiledCache.get(source);
  if (cached) {
    compiledCache.delete(source);
    compiledCache.set(source, cached);
    return cached;
  }

  const ast = parseFilter(source);
  validateFilterAst(ast);
  freezeAst(ast);

  const predicate = function playlistFilterPredicate(video, context) {
    const runtimeContext = context || createPlaylistFilterContext();
    const state = {
      budget: MAX_OPERATIONS,
      nowMilliseconds: runtimeContext.nowMilliseconds,
      scopes: [Object.freeze({video: video})]
    };
    try {
      return Boolean(evaluateNode(ast, state));
    } catch (error) {
      if (error instanceof PlaylistFilterError) throw error;
      throw filterError(`Could not evaluate the playlist filter: ${error.message}`, 'EVALUATION_ERROR');
    }
  };
  Object.defineProperties(predicate, {
    ast: {value: ast},
    source: {value: source}
  });
  Object.freeze(predicate);

  trimCache();
  compiledCache.set(source, predicate);
  return predicate;
}

function validatePlaylistFilter(source) {
  try {
    compilePlaylistFilter(source);
    return {valid: true, error: null, code: null};
  } catch (error) {
    const safeError = error instanceof PlaylistFilterError ? error : filterError(error.message, 'FILTER_ERROR');
    return {valid: false, error: safeError.message, code: safeError.code};
  }
}

function clearPlaylistFilterCache() {
  compiledCache.clear();
}

function consume(state, amount) {
  state.budget -= amount || 1;
  if (state.budget < 0) {
    throw filterError('The playlist filter did too much work for one video.', 'OPERATION_LIMIT');
  }
}

function evaluateNode(node, state) {
  consume(state, 1);

  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'Identifier':
      return resolveIdentifier(node.name, state);
    case 'UnaryExpression':
      return evaluateUnary(node.operator, evaluateNode(node.argument, state));
    case 'BinaryExpression':
    case 'LogicalExpression':
      return evaluateBinaryNode(node, state);
    case 'ConditionalExpression':
      return evaluateNode(node.test, state) ? evaluateNode(node.consequent, state) : evaluateNode(node.alternate, state);
    case 'ArrayExpression':
      return evaluateArrayLiteral(node, state);
    case 'ObjectExpression':
      return evaluateObjectLiteral(node, state);
    case 'TemplateLiteral':
      return evaluateTemplateLiteral(node, state);
    case 'MemberExpression':
      return evaluateMember(node, state);
    case 'CallExpression':
      return evaluateCall(node, state);
    case 'ArrowFunctionExpression':
      return makeCallback(node, state);
    default:
      throw filterError(`Cannot evaluate expression type "${node.type}".`, 'UNSUPPORTED_EXPRESSION');
  }
}

function evaluateArrayLiteral(node, state) {
  const result = [];
  node.elements.forEach(element => {
    if (!element) {
      result.push(undefined);
    } else if (element.type === 'SpreadElement') {
      result.push(...spreadIterable(evaluateNode(element.argument, state), state));
    } else {
      result.push(evaluateNode(element, state));
    }
    if (result.length > MAX_ARRAY_LENGTH) {
      throw filterError('A playlist filter produced an array that is too long.', 'ARRAY_TOO_LONG');
    }
  });
  return result;
}

function evaluateObjectLiteral(node, state) {
  const result = Object.create(null);
  node.properties.forEach(property => {
    if (property.type === 'SpreadElement') {
      copySafeProperties(result, evaluateNode(property.argument, state), state);
      return;
    }
    const key = property.computed ?
      propertyKey(evaluateNode(property.key, state)) :
      (property.key.type === 'Identifier' ? property.key.name : propertyKey(property.key.value));
    rejectBlockedProperty(key);
    result[key] = evaluateNode(property.value, state);
  });
  return Object.freeze(result);
}

function copySafeProperties(target, source, state) {
  if (source === null || source === undefined) return;
  const sourceKeys = safeObjectKeys(source);
  if (Object.keys(target).length + sourceKeys.length > MAX_ARRAY_LENGTH) {
    throw filterError('A playlist filter produced an object that is too large.', 'OBJECT_TOO_LARGE');
  }
  consume(state, sourceKeys.length);
  sourceKeys.forEach(key => {
    target[key] = safeGet(source, key, false);
  });
}

function evaluateTemplateLiteral(node, state) {
  let result = '';
  const expressions = node.expressions || [];
  (node.quasis || []).forEach((quasi, index) => {
    result += String(quasi && quasi.value ? quasi.value.cooked : '');
    if (index < expressions.length) result += safeString(evaluateNode(expressions[index], state));
    boundedString(result);
  });
  return result;
}

function spreadIterable(value, state) {
  let values;
  if (Array.isArray(value)) values = value.slice();
  else if (typeof value === 'string') values = Array.from(value);
  else throw filterError('Only arrays and strings can be spread here.', 'VALUE_NOT_ITERABLE');
  consume(state, values.length);
  return boundedArray(values);
}

function resolveIdentifier(name, state) {
  for (let i = state.scopes.length - 1; i >= 0; i -= 1) {
    if (Object.prototype.hasOwnProperty.call(state.scopes[i], name)) return state.scopes[i][name];
  }
  if (NAMESPACE_NAMES.has(name)) return namespaceTokens[name];
  throw filterError(`Unknown name "${name}".`, 'UNKNOWN_IDENTIFIER');
}

function evaluateUnary(operator, value) {
  switch (operator) {
    case '!': return !value;
    case '+': return toNumber(value);
    case '-': return -toNumber(value);
    case '~': return ~toNumber(value);
    case 'typeof': return safeTypeof(value);
    default: throw filterError(`Unary operator "${operator}" is not supported.`, 'UNSUPPORTED_OPERATOR');
  }
}

function evaluateBinaryNode(node, state) {
  const left = evaluateNode(node.left, state);
  if (node.operator === '&&') return left && evaluateNode(node.right, state);
  if (node.operator === '||') return left || evaluateNode(node.right, state);
  if (node.operator === '??') return left === null || left === undefined ? evaluateNode(node.right, state) : left;
  const right = evaluateNode(node.right, state);
  return evaluateBinary(node.operator, left, right);
}

function evaluateBinary(operator, left, right) {
  switch (operator) {
    case '===': return left === right;
    case '!==': return left !== right;
    case '==': return safeLooseEqual(left, right);
    case '!=': return !safeLooseEqual(left, right);
    case '<': return safeCompare(left, right) < 0;
    case '<=': return safeCompare(left, right) <= 0;
    case '>': return safeCompare(left, right) > 0;
    case '>=': return safeCompare(left, right) >= 0;
    case '+': return safeAdd(left, right);
    case '-': return toNumber(left) - toNumber(right);
    case '*': return toNumber(left) * toNumber(right);
    case '/': return toNumber(left) / toNumber(right);
    case '%': return toNumber(left) % toNumber(right);
    case '**': return toNumber(left) ** toNumber(right);
    case '&': return toNumber(left) & toNumber(right);
    case '|': return toNumber(left) | toNumber(right);
    case '^': return toNumber(left) ^ toNumber(right);
    case '<<': return toNumber(left) << toNumber(right);
    case '>>': return toNumber(left) >> toNumber(right);
    case '>>>': return toNumber(left) >>> toNumber(right);
    case 'in': return safeHasOwn(right, propertyKey(left));
    default: throw filterError(`Operator "${operator}" is not supported.`, 'UNSUPPORTED_OPERATOR');
  }
}

function safeTypeof(value) {
  if (value && value.marker === CALLBACK_MARKER) return 'function';
  if (value && value.marker === NAMESPACE_MARKER) return 'object';
  return typeof value;
}

function safeToPrimitive(value) {
  if (value === null || value === undefined) return value;
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return safeArrayToString(value);
  if (typeof value === 'object') return '[object Object]';
  throw filterError(`Values of type ${typeof value} are not available in playlist filters.`, 'UNSAFE_VALUE');
}

function safeString(value) {
  const primitive = safeToPrimitive(value);
  if (primitive === undefined) return 'undefined';
  if (primitive === null) return 'null';
  const result = String(primitive);
  return boundedString(result);
}

function safeArrayToString(array) {
  if (array.length > MAX_ARRAY_LENGTH) {
    throw filterError('An array is too long for a playlist filter.', 'ARRAY_TOO_LONG');
  }
  let result = '';
  for (let i = 0; i < array.length; i += 1) {
    if (i > 0) result += ',';
    const item = array[i];
    if (item !== undefined && item !== null) result += safeString(item);
    if (result.length > MAX_STRING_LENGTH) {
      throw filterError('A playlist filter produced text that is too long.', 'STRING_TOO_LONG');
    }
  }
  return result;
}

function toNumber(value) {
  const primitive = safeToPrimitive(value);
  return Number(primitive);
}

function safeAdd(left, right) {
  const leftPrimitive = safeToPrimitive(left);
  const rightPrimitive = safeToPrimitive(right);
  if (typeof leftPrimitive === 'string' || typeof rightPrimitive === 'string') {
    return boundedString(safeString(leftPrimitive) + safeString(rightPrimitive));
  }
  return Number(leftPrimitive) + Number(rightPrimitive);
}

function safeCompare(left, right) {
  const a = safeToPrimitive(left);
  const b = safeToPrimitive(right);
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  const aNumber = Number(a);
  const bNumber = Number(b);
  if (Number.isNaN(aNumber) || Number.isNaN(bNumber)) return NaN;
  if (aNumber === bNumber) return 0;
  return aNumber < bNumber ? -1 : 1;
}

function safeLooseEqual(left, right) {
  if (left === right) return true;
  if ((left === null && right === undefined) || (left === undefined && right === null)) return true;
  const a = safeToPrimitive(left);
  const b = safeToPrimitive(right);
  if (typeof a === typeof b) return a === b;
  if (typeof a === 'boolean') return safeLooseEqual(Number(a), b);
  if (typeof b === 'boolean') return safeLooseEqual(a, Number(b));
  if ((typeof a === 'number' && typeof b === 'string') || (typeof a === 'string' && typeof b === 'number')) {
    return Number(a) === Number(b);
  }
  return false;
}

function propertyKey(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return safeString(value);
  }
  throw filterError('Computed property names must evaluate to text or a number.', 'INVALID_PROPERTY');
}

function evaluateMember(node, state) {
  const receiver = evaluateNode(node.object, state);
  const property = node.computed ? propertyKey(evaluateNode(node.property, state)) : node.property.name;
  rejectBlockedProperty(property);

  if (receiver && receiver.marker === NAMESPACE_MARKER) {
    if (receiver.name === 'Math' && MATH_CONSTANTS.has(property)) return Math[property];
    throw filterError(`${receiver.name}.${property} is not an available value.`, 'UNSUPPORTED_NAMESPACE_PROPERTY');
  }
  return safeGet(receiver, property, Boolean(node.optional) || containsOptionalAccess(node.object));
}

function containsOptionalAccess(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.optional) return true;
  if (node.type === 'MemberExpression') return containsOptionalAccess(node.object);
  if (node.type === 'CallExpression') return containsOptionalAccess(node.callee);
  return false;
}

function safeGet(receiver, property, optional) {
  rejectBlockedProperty(property);
  if (receiver === null || receiver === undefined) {
    if (optional) return undefined;
    throw filterError(`Cannot read .${property} from an unset value. Use optional chaining (?.) if the value may be unset.`, 'PROPERTY_ON_UNSET_VALUE');
  }

  if (typeof receiver === 'string') {
    if (property === 'length') return receiver.length;
    if (isArrayIndex(property) && Number(property) < receiver.length) return receiver.charAt(Number(property));
    return undefined;
  }
  if (typeof receiver !== 'object') return undefined;

  const descriptor = Object.getOwnPropertyDescriptor(receiver, property);
  if (!descriptor) return undefined;
  if (descriptor.get || descriptor.set) {
    throw filterError(`Accessor property "${property}" cannot be read by a playlist filter.`, 'ACCESSOR_PROPERTY');
  }
  if (typeof descriptor.value === 'function' || typeof descriptor.value === 'symbol') {
    throw filterError(`Executable property "${property}" cannot be read by a playlist filter.`, 'EXECUTABLE_PROPERTY');
  }
  return descriptor.value;
}

function safeHasOwn(receiver, property) {
  rejectBlockedProperty(property);
  if (receiver === null || receiver === undefined) return false;
  if (typeof receiver === 'string') return property === 'length' || (isArrayIndex(property) && Number(property) < receiver.length);
  if (typeof receiver !== 'object') return false;
  const descriptor = Object.getOwnPropertyDescriptor(receiver, property);
  return Boolean(descriptor && !descriptor.get && !descriptor.set &&
    typeof descriptor.value !== 'function' && typeof descriptor.value !== 'symbol');
}

function isArrayIndex(property) {
  return /^(0|[1-9]\d*)$/.test(String(property));
}

function evaluateCall(node, state) {
  if (node.callee.type === 'Identifier') {
    const args = evaluateArguments(node.arguments, state);
    return callGlobal(node.callee.name, args, state);
  }

  const member = node.callee;
  const methodName = staticMemberName(member);
  if (member.object.type === 'Identifier' && NAMESPACE_NAMES.has(member.object.name)) {
    const args = evaluateArguments(node.arguments, state);
    return callNamespace(member.object.name, methodName, args, state);
  }

  const receiver = evaluateNode(member.object, state);
  if ((receiver === null || receiver === undefined) &&
      (member.optional || node.optional || containsOptionalAccess(member.object))) return undefined;
  const args = evaluateArguments(node.arguments, state);
  return callInstance(receiver, methodName, args, state);
}

function evaluateArguments(argumentNodes, state) {
  const args = [];
  argumentNodes.forEach(argument => {
    if (argument.type === 'SpreadElement') {
      args.push(...spreadIterable(evaluateNode(argument.argument, state), state));
    } else {
      args.push(evaluateNode(argument, state));
    }
    if (args.length > MAX_ARGUMENTS) {
      throw filterError(`Function calls may have at most ${MAX_ARGUMENTS} arguments after spreading.`, 'TOO_MANY_ARGUMENTS');
    }
  });
  return args;
}

function callGlobal(name, args, state) {
  switch (name) {
    case 'Boolean': return Boolean(args[0]);
    case 'Number': return args.length === 0 ? 0 : toNumber(args[0]);
    case 'String': return args.length === 0 ? '' : safeString(args[0]);
    case 'parseInt': return parseInt(safeString(args[0]), args.length > 1 ? toNumber(args[1]) : undefined);
    case 'parseFloat': return parseFloat(safeString(args[0]));
    case 'isFinite': return Number.isFinite(toNumber(args[0]));
    case 'isNaN': return Number.isNaN(toNumber(args[0]));
    case 'defined': return args[0] !== null && args[0] !== undefined;
    case 'empty': return isEmpty(args[0], state);
    case 'between': {
      const value = toNumber(args[0]);
      return value >= toNumber(args[1]) && value <= toNumber(args[2]);
    }
    case 'clamp': return Math.min(Math.max(toNumber(args[0]), toNumber(args[1])), toNumber(args[2]));
    case 'now': return Math.floor(state.nowMilliseconds / 1000);
    case 'hoursAgo': return secondsAgo(args[0], 60 * 60, state);
    case 'daysAgo': return secondsAgo(args[0], 60 * 60 * 24, state);
    case 'weeksAgo': return secondsAgo(args[0], 60 * 60 * 24 * 7, state);
    case 'yearsAgo': return secondsAgo(args[0], 60 * 60 * 24 * 365.25, state);
    case 'ageInDays': return (Math.floor(state.nowMilliseconds / 1000) - toNumber(args[0])) / (60 * 60 * 24);
    default: throw filterError(`Function ${name}() is not available in playlist filters.`, 'UNSUPPORTED_FUNCTION');
  }
}

function isEmpty(value, state) {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value) || typeof value === 'string') return value.length === 0;
  if (typeof value === 'object') return safeObjectKeys(value, state).length === 0;
  return false;
}

function secondsAgo(amount, unitSeconds, state) {
  return Math.floor(state.nowMilliseconds / 1000) - toNumber(amount) * unitSeconds;
}

function callNamespace(namespace, method, args, state) {
  switch (namespace) {
    case 'Math':
      return callMath(method, args);
    case 'Number':
      return callNumber(method, args);
    case 'String':
      return callStringStatic(method, args);
    case 'Array':
      if (method === 'isArray') return Array.isArray(args[0]);
      break;
    case 'Object':
      return callObject(method, args, state);
    case 'Date':
      if (method === 'now') return state.nowMilliseconds;
      break;
  }
  throw filterError(`${namespace}.${method}() is not available in playlist filters.`, 'UNSUPPORTED_FUNCTION');
}

function callMath(method, args) {
  if (!MATH_METHODS.has(method)) throw filterError(`Math.${method}() is not available.`, 'UNSUPPORTED_FUNCTION');
  const result = Math[method](...args.map(toNumber));
  return result;
}

function callNumber(method, args) {
  switch (method) {
    case 'isFinite': return typeof args[0] === 'number' && Number.isFinite(args[0]);
    case 'isInteger': return typeof args[0] === 'number' && Number.isInteger(args[0]);
    case 'isNaN': return typeof args[0] === 'number' && Number.isNaN(args[0]);
    case 'isSafeInteger': return typeof args[0] === 'number' && Number.isSafeInteger(args[0]);
    case 'parseFloat': return parseFloat(safeString(args[0]));
    case 'parseInt': return parseInt(safeString(args[0]), args.length > 1 ? toNumber(args[1]) : undefined);
    default: throw filterError(`Number.${method}() is not available.`, 'UNSUPPORTED_FUNCTION');
  }
}

function callStringStatic(method, args) {
  const codes = args.map(toNumber);
  let result;
  if (method === 'fromCharCode') result = String.fromCharCode(...codes);
  else if (method === 'fromCodePoint') result = String.fromCodePoint(...codes);
  else throw filterError(`String.${method}() is not available.`, 'UNSUPPORTED_FUNCTION');
  return boundedString(result);
}

function callObject(method, args, state) {
  const keys = ['keys', 'values', 'entries'].includes(method) ? safeObjectKeys(args[0], state) : null;
  switch (method) {
    case 'keys': return boundedArray(keys);
    case 'values': return boundedArray(keys.map(key => safeGet(args[0], key)));
    case 'entries': return boundedArray(keys.map(key => [key, safeGet(args[0], key)]));
    case 'hasOwn': return safeHasOwn(args[0], propertyKey(args[1]));
    case 'is': return Object.is(args[0], args[1]);
    default: throw filterError(`Object.${method}() is not available.`, 'UNSUPPORTED_FUNCTION');
  }
}

function safeObjectKeys(value, state) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    if (value.length > MAX_ARRAY_LENGTH) {
      throw filterError('A string has too many indexed properties for a playlist filter.', 'ARRAY_TOO_LONG');
    }
    if (state) consume(state, value.length);
    return Array.from({length: value.length}, (_, index) => String(index));
  }
  if (typeof value !== 'object') return [];
  const keys = Object.keys(value);
  if (keys.length > MAX_ARRAY_LENGTH) {
    throw filterError('An object has too many properties for a playlist filter.', 'ARRAY_TOO_LONG');
  }
  if (state) consume(state, keys.length);
  return keys.filter(key => !BLOCKED_PROPERTIES.has(key) && safeHasOwn(value, key));
}

function callInstance(receiver, method, args, state) {
  rejectBlockedProperty(method);
  if (Array.isArray(receiver)) return callArray(receiver, method, args, state);
  if (typeof receiver === 'string') return callString(receiver, method, args, state);
  if (typeof receiver === 'number') return callNumberInstance(receiver, method, args);
  if (typeof receiver === 'boolean') return callBooleanInstance(receiver, method);
  if (receiver === null || receiver === undefined) {
    throw filterError(`Cannot call .${method}() on an unset value.`, 'METHOD_ON_UNSET_VALUE');
  }
  if (method === 'toString') return '[object Object]';
  throw filterError(`Method .${method}() cannot be used on this type of value.`, 'WRONG_METHOD_TYPE');
}

function callString(value, method, args, state) {
  if (value.length > MAX_STRING_LENGTH) {
    throw filterError('A string is too long for a playlist filter operation.', 'STRING_TOO_LONG');
  }
  consume(state, Math.ceil(value.length / 64));
  const stringArg = index => safeString(args[index]);
  const numberArg = (index, fallback) => args[index] === undefined ? fallback : toNumber(args[index]);
  let result;

  switch (method) {
    case 'at': {
      let index = Math.trunc(numberArg(0, 0));
      if (index < 0) index = value.length + index;
      return index >= 0 && index < value.length ? value.charAt(index) : undefined;
    }
    case 'charAt': return value.charAt(numberArg(0, 0));
    case 'charCodeAt': return value.charCodeAt(numberArg(0, 0));
    case 'codePointAt': return value.codePointAt(numberArg(0, 0));
    case 'concat': result = value + args.map(safeString).join(''); break;
    case 'endsWith': return value.endsWith(stringArg(0), numberArg(1, value.length));
    case 'includes': return value.includes(stringArg(0), numberArg(1, 0));
    case 'indexOf': return value.indexOf(stringArg(0), numberArg(1, 0));
    case 'lastIndexOf': return value.lastIndexOf(stringArg(0), args[1] === undefined ? value.length : numberArg(1));
    case 'localeCompare': return value.localeCompare(stringArg(0));
    case 'normalize': result = value.normalize(args[0] === undefined ? undefined : stringArg(0)); break;
    case 'padEnd': result = value.padEnd(assertOutputLength(numberArg(0, 0)), args[1] === undefined ? ' ' : stringArg(1)); break;
    case 'padStart': result = value.padStart(assertOutputLength(numberArg(0, 0)), args[1] === undefined ? ' ' : stringArg(1)); break;
    case 'repeat': {
      const count = Math.trunc(numberArg(0, 0));
      if (count < 0 || !Number.isFinite(count) || value.length * count > MAX_STRING_LENGTH) {
        throw filterError('String repetition would produce too much text.', 'STRING_TOO_LONG');
      }
      result = value.repeat(count);
      break;
    }
    case 'replace': result = value.replace(stringArg(0), stringArg(1)); break;
    case 'replaceAll': result = replaceAllLiteral(value, stringArg(0), stringArg(1)); break;
    case 'slice': return value.slice(numberArg(0, 0), args[1] === undefined ? undefined : numberArg(1));
    case 'split': {
      const separator = args[0] === undefined ? undefined : stringArg(0);
      const limit = args[1] === undefined ? MAX_ARRAY_LENGTH : Math.min(MAX_ARRAY_LENGTH, Math.max(0, Math.trunc(numberArg(1))));
      return boundedArray(value.split(separator, limit));
    }
    case 'startsWith': return value.startsWith(stringArg(0), numberArg(1, 0));
    case 'substr': return value.substr(numberArg(0, 0), args[1] === undefined ? undefined : numberArg(1));
    case 'substring': return value.substring(numberArg(0, 0), args[1] === undefined ? undefined : numberArg(1));
    case 'toLowerCase': result = value.toLowerCase(); break;
    case 'toString': return value;
    case 'toUpperCase': result = value.toUpperCase(); break;
    case 'trim': result = value.trim(); break;
    case 'trimEnd': result = value.trimEnd(); break;
    case 'trimStart': result = value.trimStart(); break;
    case 'valueOf': return value;
    default: throw filterError(`String method .${method}() is not available.`, 'UNSUPPORTED_METHOD');
  }
  return boundedString(result);
}

function replaceAllLiteral(value, search, replacement) {
  if (search === '') {
    const result = replacement + value.split('').join(replacement) + replacement;
    return boundedString(result);
  }
  return boundedString(value.split(search).join(replacement));
}

function callNumberInstance(value, method, args) {
  switch (method) {
    case 'toExponential': return boundedString(value.toExponential(args[0] === undefined ? undefined : toNumber(args[0])));
    case 'toFixed': return boundedString(value.toFixed(args[0] === undefined ? 0 : toNumber(args[0])));
    case 'toPrecision': return boundedString(value.toPrecision(args[0] === undefined ? undefined : toNumber(args[0])));
    case 'toString': return boundedString(value.toString(args[0] === undefined ? 10 : toNumber(args[0])));
    case 'valueOf': return value;
    default: throw filterError(`Number method .${method}() is not available.`, 'UNSUPPORTED_METHOD');
  }
}

function callBooleanInstance(value, method) {
  if (method === 'toString') return value ? 'true' : 'false';
  if (method === 'valueOf') return value;
  throw filterError(`Boolean method .${method}() is not available.`, 'UNSUPPORTED_METHOD');
}

function callArray(array, method, args, state) {
  if (array.length > MAX_ARRAY_LENGTH) {
    throw filterError('An array is too long for a playlist filter.', 'ARRAY_TOO_LONG');
  }
  consume(state, array.length);

  switch (method) {
    case 'at': {
      let index = Math.trunc(toNumber(args[0] === undefined ? 0 : args[0]));
      if (index < 0) index = array.length + index;
      return index >= 0 && index < array.length ? array[index] : undefined;
    }
    case 'concat': return boundedArray(array.concat(...args.map(value => Array.isArray(value) ? value : [value])));
    case 'includes': return array.includes(args[0], args[1] === undefined ? 0 : toNumber(args[1]));
    case 'indexOf': return array.indexOf(args[0], args[1] === undefined ? 0 : toNumber(args[1]));
    case 'lastIndexOf': return array.lastIndexOf(args[0], args[1] === undefined ? array.length - 1 : toNumber(args[1]));
    case 'join': return boundedString(array.map(item => item === undefined || item === null ? '' : safeString(item)).join(args[0] === undefined ? ',' : safeString(args[0])));
    case 'slice': return boundedArray(array.slice(args[0] === undefined ? 0 : toNumber(args[0]), args[1] === undefined ? undefined : toNumber(args[1])));
    case 'toString': return safeArrayToString(array);
    case 'keys': return boundedArray(array.map((_, index) => index));
    case 'values': return boundedArray(array.slice());
    case 'entries': return boundedArray(array.map((value, index) => [index, value]));
    case 'flat': return flattenArray(array, args[0] === undefined ? 1 : toNumber(args[0]), state);
    case 'some': return iterateCallback(array, args[0], state, 'some');
    case 'every': return iterateCallback(array, args[0], state, 'every');
    case 'filter': return iterateCallback(array, args[0], state, 'filter');
    case 'map': return iterateCallback(array, args[0], state, 'map');
    case 'find': return iterateCallback(array, args[0], state, 'find');
    case 'findIndex': return iterateCallback(array, args[0], state, 'findIndex');
    case 'flatMap': return flattenArray(iterateCallback(array, args[0], state, 'map'), 1, state);
    case 'reduce': return reduceCallback(array, args, state, false);
    case 'reduceRight': return reduceCallback(array, args, state, true);
    default: throw filterError(`Array method .${method}() is not available.`, 'UNSUPPORTED_METHOD');
  }
}

function assertCallback(callback) {
  if (!callback || callback.marker !== CALLBACK_MARKER) {
    throw filterError('This array method requires an arrow-function callback.', 'CALLBACK_REQUIRED');
  }
}

function makeCallback(node, state) {
  return Object.freeze({
    marker: CALLBACK_MARKER,
    node: node,
    capturedScopes: state.scopes.slice()
  });
}

function invokeCallback(callback, args, state) {
  assertCallback(callback);
  const scope = Object.create(null);
  (callback.node.params || []).forEach((param, index) => {
    scope[param.name] = args[index];
  });
  const oldScopes = state.scopes;
  state.scopes = callback.capturedScopes.concat([Object.freeze(scope)]);
  try {
    return evaluateNode(callback.node.body, state);
  } finally {
    state.scopes = oldScopes;
  }
}

function iterateCallback(array, callback, state, mode) {
  assertCallback(callback);
  const output = [];
  for (let index = 0; index < array.length; index += 1) {
    consume(state, 1);
    const value = array[index];
    const result = invokeCallback(callback, [value, index, array], state);
    if (mode === 'some' && result) return true;
    if (mode === 'every' && !result) return false;
    if (mode === 'find' && result) return value;
    if (mode === 'findIndex' && result) return index;
    if (mode === 'filter' && result) output.push(value);
    if (mode === 'map') output.push(result);
    if (output.length > MAX_ARRAY_LENGTH) throw filterError('A playlist filter produced an array that is too long.', 'ARRAY_TOO_LONG');
  }
  if (mode === 'some') return false;
  if (mode === 'every') return true;
  if (mode === 'find') return undefined;
  if (mode === 'findIndex') return -1;
  return boundedArray(output);
}

function reduceCallback(array, args, state, reverse) {
  const callback = args[0];
  assertCallback(callback);
  if (array.length === 0 && args.length < 2) {
    throw filterError('Cannot reduce an empty array without an initial value.', 'EMPTY_REDUCE');
  }

  let index = reverse ? array.length - 1 : 0;
  const step = reverse ? -1 : 1;
  let accumulator;
  if (args.length >= 2) {
    accumulator = args[1];
  } else {
    accumulator = array[index];
    index += step;
  }

  for (; reverse ? index >= 0 : index < array.length; index += step) {
    consume(state, 1);
    accumulator = invokeCallback(callback, [accumulator, array[index], index, array], state);
  }
  return accumulator;
}

function flattenArray(array, requestedDepth, state) {
  const depth = requestedDepth === Infinity ? 10 : Math.max(0, Math.min(10, Math.trunc(requestedDepth)));
  const output = [];
  const append = (value, remaining) => {
    consume(state, 1);
    if (Array.isArray(value) && remaining > 0) {
      value.forEach(item => append(item, remaining - 1));
    } else {
      output.push(value);
      if (output.length > MAX_ARRAY_LENGTH) throw filterError('A playlist filter produced an array that is too long.', 'ARRAY_TOO_LONG');
    }
  };
  array.forEach(value => append(value, depth));
  return output;
}

function assertOutputLength(length) {
  const normalized = Math.max(0, Math.trunc(length));
  if (!Number.isFinite(normalized) || normalized > MAX_STRING_LENGTH) {
    throw filterError('A playlist filter tried to produce too much text.', 'STRING_TOO_LONG');
  }
  return normalized;
}

function boundedString(value) {
  if (value.length > MAX_STRING_LENGTH) {
    throw filterError('A playlist filter produced text that is too long.', 'STRING_TOO_LONG');
  }
  return value;
}

function boundedArray(value) {
  if (value.length > MAX_ARRAY_LENGTH) {
    throw filterError('A playlist filter produced an array that is too long.', 'ARRAY_TOO_LONG');
  }
  return value;
}

module.exports = {
  PLAYLIST_FILTER_REFERENCE,
  PlaylistFilterError,
  clearPlaylistFilterCache,
  compilePlaylistFilter,
  createPlaylistFilterContext,
  validatePlaylistFilter
};
