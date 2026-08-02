import ts from "typescript";

const TEST_MODIFIERS = new Set(["only", "skip", "fixme", "fail", "slow"]);
const DESCRIBE_MODIFIERS = new Set(["only", "skip", "fixme", "serial", "parallel"]);
const LOCATOR_METHODS = new Set([
  "locator",
  "frameLocator",
  "getByAltText",
  "getByLabel",
  "getByPlaceholder",
  "getByRole",
  "getByTestId",
  "getByText",
  "getByTitle",
]);
const LOCATOR_CHAIN_METHODS = new Set(["and", "filter", "first", "last", "nth", "or"]);
const ACTION_METHODS = new Set([
  "blur",
  "check",
  "clear",
  "click",
  "dblclick",
  "dispatchEvent",
  "dragTo",
  "fill",
  "focus",
  "hover",
  "press",
  "pressSequentially",
  "selectOption",
  "setChecked",
  "setInputFiles",
  "tap",
  "type",
  "uncheck",
]);
const PAGE_ACTION_METHODS = new Set(["goBack", "goForward", "goto", "reload"]);
const MATCHERS = new Set([
  "toBeAttached",
  "toBeChecked",
  "toBeDisabled",
  "toBeEditable",
  "toBeEmpty",
  "toBeEnabled",
  "toBeFocused",
  "toBeHidden",
  "toBeInViewport",
  "toBeVisible",
  "toContainText",
  "toHaveAccessibleDescription",
  "toHaveAccessibleErrorMessage",
  "toHaveAccessibleName",
  "toHaveAttribute",
  "toHaveClass",
  "toHaveCount",
  "toHaveCSS",
  "toHaveId",
  "toHaveJSProperty",
  "toHaveRole",
  "toHaveText",
  "toHaveTitle",
  "toHaveURL",
  "toHaveValue",
  "toHaveValues",
]);

function callPath(expression) {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = callPath(expression.expression);
    return parent ? [...parent, expression.name.text] : null;
  }
  return null;
}

function sourceText(node, sourceFile) {
  return node ? node.getText(sourceFile) : "";
}

function diagnostic(sourceFile, code, severity, message, node) {
  const start = node?.getStart(sourceFile) ?? 0;
  const position = sourceFile.getLineAndCharacterOfPosition(start);
  return {
    code,
    severity,
    message,
    path: `${sourceFile.fileName}:${position.line + 1}:${position.character + 1}`,
    source: node ? sourceText(node, sourceFile) : undefined,
    // Raw character offset binds the diagnostic to the test whose source range contains it.
    offset: start,
  };
}

function regexValue(text) {
  const lastSlash = text.lastIndexOf("/");
  return {
    kind: "regex",
    pattern: text.slice(1, lastSlash),
    flags: text.slice(lastSlash + 1),
  };
}

function staticValue(node, sourceFile, values = new Map()) {
  if (!node) return { kind: "literal", value: null };
  if (ts.isParenthesizedExpression(node)) return staticValue(node.expression, sourceFile, values);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: "literal", value: node.text };
  }
  if (ts.isNumericLiteral(node)) return { kind: "literal", value: Number(node.text) };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: "literal", value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "literal", value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: "literal", value: null };
  if (ts.isRegularExpressionLiteral(node)) return regexValue(node.text);
  if (ts.isIdentifier(node) && values.has(node.text)) return structuredClone(values.get(node.text));
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return { kind: "literal", value: -Number(node.operand.text) };
  }
  if (ts.isArrayLiteralExpression(node)) {
    return {
      kind: "array",
      value: node.elements.map(element => staticValue(element, sourceFile, values)),
    };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        return { kind: "dynamic", source: sourceText(node, sourceFile) };
      }
      const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        ? property.name.text
        : null;
      if (!name) return { kind: "dynamic", source: sourceText(node, sourceFile) };
      value[name] = staticValue(property.initializer, sourceFile, values);
    }
    return { kind: "object", value };
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticValue(span.expression, sourceFile, values);
      if (expression.kind !== "literal") {
        return { kind: "dynamic", source: sourceText(node, sourceFile) };
      }
      value += String(expression.value) + span.literal.text;
    }
    return { kind: "literal", value };
  }
  return { kind: "dynamic", source: sourceText(node, sourceFile) };
}

function locatorOperation(method, args, sourceFile, values) {
  const parsedArgs = args.map(argument => staticValue(argument, sourceFile, values));
  return { method, arguments: parsedArgs };
}

function appendLocatorOperation(base, operation) {
  if (base.kind === "chain") {
    return { ...base, operations: [...base.operations, operation] };
  }
  return { kind: "chain", root: base, operations: [operation] };
}

function literalOf(value) {
  return value?.kind === "literal" ? value.value : value;
}

function rootLocator(method, args, sourceFile, values) {
  const first = staticValue(args[0], sourceFile, values);
  if (method === "getByTestId") return { kind: "testId", value: literalOf(first), ...(args.length > 1 ? { unrepresentable: true } : {}) };
  if (method === "getByText") return { kind: "text", value: literalOf(first), ...(args.length > 1 ? { unrepresentable: true } : {}) };
  if (method === "getByRole") {
    const options = staticValue(args[1], sourceFile, values);
    const name = options.kind === "object" ? options.value.name : undefined;
    const representableOptions = args.length === 1 || (
      options.kind === "object"
      && Object.keys(options.value).length === 1
      && name?.kind === "literal"
      && typeof name.value === "string"
      && name.value.length > 0
    );
    return {
      kind: "role",
      role: literalOf(first),
      ...(name ? { name: literalOf(name) } : {}),
      ...(!representableOptions ? { unrepresentable: true } : {}),
    };
  }
  const kind = {
    getByAltText: "altText",
    getByLabel: "label",
    getByPlaceholder: "placeholder",
    getByTitle: "title",
    locator: "locator",
    frameLocator: "frameLocator",
  }[method] ?? method;
  return { kind, value: literalOf(first) };
}

function parseLocator(node, sourceFile, values, locators) {
  if (!node) return null;
  if (ts.isParenthesizedExpression(node)) return parseLocator(node.expression, sourceFile, values, locators);
  if (ts.isIdentifier(node) && locators.has(node.text)) return structuredClone(locators.get(node.text));
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;

  const method = node.expression.name.text;
  const receiver = node.expression.expression;
  if (LOCATOR_METHODS.has(method)) {
    const operation = locatorOperation(method, node.arguments, sourceFile, values);
    if (ts.isIdentifier(receiver) && ["page", "frame"].includes(receiver.text)) {
      return rootLocator(method, node.arguments, sourceFile, values);
    }
    const base = parseLocator(receiver, sourceFile, values, locators);
    return base ? appendLocatorOperation(base, operation) : null;
  }
  if (LOCATOR_CHAIN_METHODS.has(method)) {
    const base = parseLocator(receiver, sourceFile, values, locators);
    return base
      ? appendLocatorOperation(base, locatorOperation(method, node.arguments, sourceFile, values))
      : null;
  }
  return null;
}

function collectBindings(sourceFile) {
  const test = new Set(["test"]);
  const expect = new Set(["expect"]);

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === "test") test.add(element.name.text);
      if (imported === "expect") expect.add(element.name.text);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    const visit = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
        const path = callPath(node.initializer.expression);
        if (path?.at(-1) === "extend" && test.has(path[0]) && !test.has(node.name.text)) {
          test.add(node.name.text);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { test, expect };
}

function testCallInfo(node, bindings) {
  if (!ts.isCallExpression(node)) return null;
  const path = callPath(node.expression);
  if (!path || !bindings.test.has(path[0])) return null;
  if (path[1] === "describe") return null;
  const modifier = TEST_MODIFIERS.has(path[1]) ? path[1] : null;
  if (path.length > (modifier ? 2 : 1)) return null;
  const callback = node.arguments.find(argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
  if (!callback) return null;
  return { modifier, callback, titleNode: node.arguments[0] };
}

function describeCallInfo(node, bindings) {
  if (!ts.isCallExpression(node)) return null;
  const path = callPath(node.expression);
  if (!path || !bindings.test.has(path[0]) || path[1] !== "describe") return null;
  const modifier = DESCRIBE_MODIFIERS.has(path[2]) ? path[2] : null;
  const callback = node.arguments.find(argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
  if (!callback) return null;
  return { modifier, callback, titleNode: node.arguments[0] };
}

function unwrapExpectMatcher(node, bindings) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const matcher = node.expression.name.text;
  let receiver = node.expression.expression;
  let negated = false;
  if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "not") {
    negated = true;
    receiver = receiver.expression;
  }
  if (!ts.isCallExpression(receiver)) return null;
  const path = callPath(receiver.expression);
  if (!path || !bindings.expect.has(path[0]) || (path.length > 1 && path[1] !== "soft")) return null;
  return {
    matcher,
    negated,
    soft: path[1] === "soft",
    targetNode: receiver.arguments[0],
    args: node.arguments,
  };
}

function expectationType(matcher, negated) {
  if (matcher === "toBeVisible") return negated ? "notVisible" : "visible";
  if (matcher === "toBeHidden") return negated ? "visible" : "notVisible";
  if (matcher === "toContainText") return "containText";
  if (matcher === "toHaveText") return "text";
  if (matcher === "toHaveCount") return "count";
  if (matcher === "toHaveURL") return "url";
  if (matcher === "toHaveTitle") return "title";
  if (matcher.startsWith("toBe")) return matcher.slice(4, 5).toLowerCase() + matcher.slice(5);
  return matcher.slice(2, 3).toLowerCase() + matcher.slice(3);
}

function parseExpectation(info, sourceFile, values, locators, diagnostics, node) {
  const locator = parseLocator(info.targetNode, sourceFile, values, locators);
  const type = expectationType(info.matcher, info.negated);
  const expectedIndex = info.matcher === "toHaveAttribute" || info.matcher === "toHaveCSS" || info.matcher === "toHaveJSProperty" ? 1 : 0;
  const expectedNode = info.args[expectedIndex];
  const expectation = {
    type,
    ...(locator ? { locator } : {}),
    ...(info.soft ? { soft: true } : {}),
    ...(info.negated && info.matcher === "toBeHidden" ? { negated: true } : {}),
  };
  if (expectedNode) {
    expectation.expected = staticValue(expectedNode, sourceFile, values);
    if (expectation.expected.kind === "dynamic") {
      diagnostics.push(diagnostic(sourceFile, "DYNAMIC_EXPECTED_VALUE", "ERROR", `Expected value for ${info.matcher} cannot be resolved statically.`, expectedNode));
    }
  }
  if (!locator && !["toHaveTitle", "toHaveURL"].includes(info.matcher)) {
    diagnostics.push(diagnostic(sourceFile, "OPAQUE_ASSERTION_TARGET", "ERROR", `Target for ${info.matcher} cannot be resolved statically.`, info.targetNode ?? node));
  }
  if (["toHaveAttribute", "toHaveCSS", "toHaveJSProperty"].includes(info.matcher) && info.args[0]) {
    expectation.property = literalOf(staticValue(info.args[0], sourceFile, values));
  }
  return expectation;
}

function analyzeCallback(callback, sourceFile, bindings, diagnostics) {
  const values = new Map();
  const locators = new Map();
  const expectations = [];
  const actions = [];
  const opaqueCalls = [];

  const collectVariables = node => {
    if (node !== callback && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = staticValue(node.initializer, sourceFile, values);
      if (value.kind !== "dynamic") values.set(node.name.text, value);
      const locator = parseLocator(node.initializer, sourceFile, values, locators);
      if (locator) locators.set(node.name.text, locator);
    }
    ts.forEachChild(node, collectVariables);
  };
  collectVariables(callback.body);

  const visit = node => {
    if (node !== callback.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const matcher = unwrapExpectMatcher(node, bindings);
      if (matcher) {
        if (!MATCHERS.has(matcher.matcher)) {
          diagnostics.push(diagnostic(sourceFile, "UNSUPPORTED_MATCHER", "ERROR", `Unsupported Playwright matcher: ${matcher.matcher}`, node));
        } else {
          expectations.push(parseExpectation(matcher, sourceFile, values, locators, diagnostics, node));
        }
        return;
      }

      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression;
        if (ACTION_METHODS.has(method)) {
          const target = parseLocator(receiver, sourceFile, values, locators);
          if (target) {
            actions.push({
              type: method,
              target,
              arguments: node.arguments.map(argument => staticValue(argument, sourceFile, values)),
            });
          } else {
            diagnostics.push(diagnostic(sourceFile, "OPAQUE_ACTION_TARGET", "ERROR", `Cannot resolve target for ${method} action.`, node));
          }
          return;
        }
        if (PAGE_ACTION_METHODS.has(method) && ts.isIdentifier(receiver) && receiver.text === "page") {
          actions.push({
            type: method,
            target: { kind: "page" },
            arguments: node.arguments.map(argument => staticValue(argument, sourceFile, values)),
          });
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);

  const inspectStatement = statement => {
    if (ts.isBlock(statement)) {
      statement.statements.forEach(inspectStatement);
      return;
    }
    if (ts.isVariableStatement(statement) || ts.isEmptyStatement(statement) || ts.isFunctionDeclaration(statement)) return;
    if (!ts.isExpressionStatement(statement)) {
      opaqueCalls.push(sourceText(statement, sourceFile));
      return;
    }
    let expression = statement.expression;
    if (ts.isAwaitExpression(expression)) expression = expression.expression;
    if (!ts.isCallExpression(expression)) {
      opaqueCalls.push(sourceText(statement, sourceFile));
      return;
    }
    if (unwrapExpectMatcher(expression, bindings)) return;
    if (ts.isPropertyAccessExpression(expression.expression)) {
      const method = expression.expression.name.text;
      if (ACTION_METHODS.has(method) || PAGE_ACTION_METHODS.has(method)) return;
    }
    opaqueCalls.push(sourceText(statement, sourceFile));
  };
  if (ts.isBlock(callback.body)) callback.body.statements.forEach(inspectStatement);
  return { actions, expectations, opaqueCalls };
}

export function parsePlaywrightAst(fileName, source) {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics = sourceFile.parseDiagnostics.map(item => diagnostic(
    sourceFile,
    "PARSE_ERROR",
    "ERROR",
    ts.flattenDiagnosticMessageText(item.messageText, "\n"),
    item.start == null ? sourceFile : { getStart: () => item.start, getText: () => "" },
  ));
  const bindings = collectBindings(sourceFile);
  const describes = [];
  const tests = [];

  const visit = node => {
    const describe = describeCallInfo(node, bindings);
    if (describe) {
      const title = staticValue(describe.titleNode, sourceFile);
      describes.push({
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        title: title.kind === "literal" ? String(title.value) : sourceText(describe.titleNode, sourceFile),
        modifier: describe.modifier,
      });
    }
    const test = testCallInfo(node, bindings);
    if (test) {
      const title = staticValue(test.titleNode, sourceFile);
      if (title.kind !== "literal" || typeof title.value !== "string") {
        diagnostics.push(diagnostic(sourceFile, "DYNAMIC_TEST_TITLE", "ERROR", "Test title must be statically resolvable.", test.titleNode));
      }
      const analyzed = analyzeCallback(test.callback, sourceFile, bindings, diagnostics);
      tests.push({
        title: title.kind === "literal" ? String(title.value) : sourceText(test.titleNode, sourceFile),
        body: ts.isBlock(test.callback.body) ? source.slice(test.callback.body.getStart(sourceFile) + 1, test.callback.body.getEnd() - 1) : sourceText(test.callback.body, sourceFile),
        index: node.getStart(sourceFile),
        bodyStart: test.callback.body.getStart(sourceFile),
        endIndex: node.getEnd(),
        modifier: test.modifier,
        ...analyzed,
      });
      if (test.modifier === "only") diagnostics.push(diagnostic(sourceFile, "FOCUSED_TEST", "WARNING", "test.only is imported without filtering sibling tests.", node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  describes.sort((left, right) => left.start - right.start);
  tests.sort((left, right) => left.index - right.index);
  for (const test of tests) {
    test.describes = describes.filter(describe => describe.start < test.index && test.endIndex < describe.end);
  }
  return { sourceFile, tests, describes, diagnostics };
}
