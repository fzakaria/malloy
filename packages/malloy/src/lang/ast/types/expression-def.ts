/*
 * Copyright 2023 Google LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files
 * (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge,
 * publish, distribute, sublicense, and/or sell copies of the Software,
 * and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import {
  DivFragment,
  Expr,
  TimestampUnit,
  isDateUnit,
  isTimeFieldType,
  maxExpressionType,
  FieldValueType,
  mergeEvalSpaces,
  maxOfExpressionTypes,
  ExpressionValueType,
} from '../../../model/malloy_types';

import {errorFor} from '../ast-utils';
import {compose, nullsafeNot} from '../expressions/utils';
import {FT} from '../fragtype-utils';
import {timeOffset, timeResult} from '../time-utils';
import {isComparison} from './comparison';
import {Equality, isEquality} from './equality';
import {ExprValue} from './expr-value';
import {FieldSpace} from './field-space';
import {isGranularResult} from './granular-result';
import {MalloyElement} from './malloy-element';

class TypeMismatch extends Error {}

/**
 * Root node for any element in an expression. These essentially
 * create a sub-tree in the larger AST. Expression nodes know
 * how to write themselves as SQL (or rather, generate the
 * template for SQL required by the query writer)
 */
export abstract class ExpressionDef extends MalloyElement {
  abstract elementType: string;
  granular(): boolean {
    return false;
  }

  /**
   * Returns the "translation" or template for SQL generation. When asking
   * for a translation you may pass the types you can accept, allowing
   * the translation code a chance to convert to match your expectations
   * @param space Namespace for looking up field references
   */
  abstract getExpression(fs: FieldSpace): ExprValue;
  legalChildTypes = FT.anyAtomicT;

  /**
   * Some operators want to give the right hand value a chance to
   * rewrite itself. This requests a translation for a rewrite,
   * or returns undefined if that request should be denied.
   * @param fs FieldSpace
   * @return Translated expression or undefined
   */
  requestExpression(fs: FieldSpace): ExprValue | undefined {
    return this.getExpression(fs);
  }

  defaultFieldName(): string | undefined {
    return undefined;
  }

  /**
   * Check an expression for type compatibility
   * @param _eNode currently unused, will be used to get error location
   * @param eVal ...list of expressions that must match legalChildTypes
   */
  typeCheck(eNode: ExpressionDef, eVal: ExprValue): boolean {
    if (eVal.dataType !== 'error' && !FT.in(eVal, this.legalChildTypes)) {
      eNode.log(`'${this.elementType}' Can't use type ${FT.inspect(eVal)}`);
      return false;
    }
    return true;
  }

  /**
   * This is the operation which makes partial comparison and value trees work
   * The default implementation merely constructs LEFT OP RIGHT, but specialized
   * nodes like alternation trees or or partial comparison can control how
   * the appplication gets generated
   * @param fs The symbol table
   * @param op The operator being applied
   * @param expr The "other" (besdies 'this') value
   * @return The translated expression
   */
  apply(fs: FieldSpace, op: string, left: ExpressionDef): ExprValue {
    return applyBinary(fs, left, op, this);
  }
}

export class ExprDuration extends ExpressionDef {
  elementType = 'duration';
  legalChildTypes = [FT.timestampT, FT.dateT];
  constructor(readonly n: ExpressionDef, readonly timeframe: TimestampUnit) {
    super({n: n});
  }

  apply(fs: FieldSpace, op: string, left: ExpressionDef): ExprValue {
    const lhs = left.getExpression(fs);
    this.typeCheck(this, lhs);
    if (isTimeFieldType(lhs.dataType) && (op === '+' || op === '-')) {
      const num = this.n.getExpression(fs);
      if (!FT.typeEq(num, FT.numberT)) {
        this.log(`Duration units needs number not '${num.dataType}`);
        return errorFor('illegal unit expression');
      }
      let resultGranularity: TimestampUnit | undefined;
      // Only allow the output of this to be granular if the
      // granularities match, this is still an area where
      // more thought is required.
      if (isGranularResult(lhs) && lhs.timeframe === this.timeframe) {
        resultGranularity = lhs.timeframe;
      }
      if (lhs.dataType === 'timestamp') {
        const result = timeOffset(
          'timestamp',
          lhs.value,
          op,
          num.value,
          this.timeframe
        );
        return timeResult(
          {
            dataType: 'timestamp',
            expressionType: maxExpressionType(
              lhs.expressionType,
              num.expressionType
            ),
            evalSpace: mergeEvalSpaces(lhs.evalSpace, num.evalSpace),
            value: result,
          },
          resultGranularity
        );
      }
      if (isDateUnit(this.timeframe)) {
        return timeResult(
          {
            dataType: 'date',
            expressionType: maxExpressionType(
              lhs.expressionType,
              num.expressionType
            ),
            evalSpace: mergeEvalSpaces(lhs.evalSpace, num.evalSpace),
            value: timeOffset('date', lhs.value, op, num.value, this.timeframe),
          },
          resultGranularity
        );
      } else {
        this.log(`Cannot offset date by ${this.timeframe}`);
        return errorFor('ofsset date error');
      }
    }
    return super.apply(fs, op, left);
  }

  getExpression(_fs: FieldSpace): ExprValue {
    return {
      dataType: 'duration',
      expressionType: 'scalar',
      value: ['__ERROR_DURATION_IS_NOT_A_VALUE__'],
      evalSpace: 'constant',
    };
  }
}

function willMorphTo(ev: ExprValue, t: string): Expr | undefined {
  if (ev.dataType === t) {
    return ev.value;
  }
  return ev.morphic && ev.morphic[t];
}

export function getMorphicValue(
  mv: ExprValue,
  mt: FieldValueType
): ExprValue | undefined {
  if (mv.dataType === mt) {
    return mv;
  }
  if (mv.morphic && mv.morphic[mt]) {
    return {
      ...mv,
      dataType: mt,
      value: mv.morphic[mt],
    };
  }
}

function timeCompare(
  left: ExpressionDef,
  lhs: ExprValue,
  op: string,
  rhs: ExprValue
): Expr | undefined {
  const leftIsTime = isTimeFieldType(lhs.dataType);
  const rightIsTime = isTimeFieldType(rhs.dataType);
  if (leftIsTime && rightIsTime) {
    if (lhs.dataType !== rhs.dataType) {
      const lval = willMorphTo(lhs, 'timestamp');
      const rval = willMorphTo(rhs, 'timestamp');
      if (lval && rval) {
        return compose(lval, op, rval);
      }
    } else {
      return compose(lhs.value, op, rhs.value);
    }
  }
  if (
    (leftIsTime || rightIsTime) &&
    lhs.dataType !== 'null' &&
    rhs.dataType !== 'null'
  ) {
    left.log(`Cannot compare a ${lhs.dataType} to a ${rhs.dataType}`);
    return ['false'];
  }
  return undefined;
}

function regexEqual(left: ExprValue, right: ExprValue): Expr | undefined {
  if (left.dataType === 'string') {
    if (right.dataType === 'regular expression') {
      return [
        {
          type: 'dialect',
          function: 'regexpMatch',
          expr: left.value,
          regexp: right.value,
        },
      ];
    }
  } else if (right.dataType === 'string') {
    if (left.dataType === 'regular expression') {
      return [
        {
          type: 'dialect',
          function: 'regexpMatch',
          expr: right.value,
          regexp: left.value,
        },
      ];
    }
  }
  return undefined;
}

function nullCompare(
  left: ExprValue,
  op: string,
  right: ExprValue
): Expr | undefined {
  const not = op === '!=' || op === '!~';
  if (left.dataType === 'null' || right.dataType === 'null') {
    const maybeNot = not ? ' NOT' : '';
    if (left.dataType !== 'null') {
      return [...left.value, ` IS${maybeNot} NULL`];
    }
    if (right.dataType !== 'null') {
      return [...right.value, `IS${maybeNot} NULL`];
    }
    return [not ? 'false' : 'true'];
  }
  return undefined;
}

function equality(
  fs: FieldSpace,
  left: ExpressionDef,
  op: Equality,
  right: ExpressionDef
): ExprValue {
  const lhs = left.getExpression(fs);
  const rhs = right.getExpression(fs);

  const err = errorCascade('boolean', lhs, rhs);
  if (err) return err;

  // Unsupported types can be compare with null
  const checkUnsupport =
    lhs.dataType === 'unsupported' || rhs.dataType === 'unsupported';
  if (checkUnsupport) {
    const oneNull = lhs.dataType === 'null' || rhs.dataType === 'null';
    const rawMatch = lhs.rawType && lhs.rawType === rhs.rawType;
    if (!(oneNull || rawMatch)) {
      const noGo = unsupportError(left, lhs, right, rhs);
      if (noGo) {
        return {...noGo, dataType: 'boolean'};
      }
    }
  }
  let value =
    timeCompare(left, lhs, op, rhs) || compose(lhs.value, op, rhs.value);

  if (lhs.dataType !== 'error' && rhs.dataType !== 'error') {
    switch (op) {
      case '~':
      case '!~': {
        if (lhs.dataType === 'string' && rhs.dataType === 'string') {
          value = compose(lhs.value, 'LIKE', rhs.value);
        } else {
          const regexCmp = regexEqual(lhs, rhs);
          if (regexCmp === undefined) {
            throw new TypeMismatch(
              "Incompatible types for match('~') operator"
            );
          }
          value = regexCmp;
        }
        value = nullsafeNot(value, op);
        break;
      }
      case '=':
      case '!=': {
        const nullCmp = nullCompare(lhs, op, rhs);
        if (nullCmp) {
          value = nullCmp;
        } else {
          value = nullsafeNot(
            regexEqual(lhs, rhs) || compose(lhs.value, '=', rhs.value),
            op
          );
        }
        break;
      }
    }
  }

  return {
    dataType: 'boolean',
    expressionType: maxExpressionType(lhs.expressionType, rhs.expressionType),
    evalSpace: mergeEvalSpaces(lhs.evalSpace, rhs.evalSpace),
    value,
  };
}

function compare(
  fs: FieldSpace,
  left: ExpressionDef,
  op: string,
  right: ExpressionDef
): ExprValue {
  const lhs = left.getExpression(fs);
  const rhs = right.getExpression(fs);

  const err = errorCascade('boolean', lhs, rhs);
  if (err) return err;

  const expressionType = maxExpressionType(
    lhs.expressionType,
    rhs.expressionType
  );
  const noCompare = unsupportError(left, lhs, right, rhs);
  if (noCompare) {
    return {...noCompare, dataType: 'boolean'};
  }
  const value =
    timeCompare(left, lhs, op, rhs) || compose(lhs.value, op, rhs.value);

  return {
    dataType: 'boolean',
    expressionType,
    evalSpace: mergeEvalSpaces(lhs.evalSpace, rhs.evalSpace),
    value: value,
  };
}

function oneOf(op: string, ...operators: string[]): boolean {
  return operators.includes(op);
}

function allAre(oneType: FieldValueType, ...values: ExprValue[]): boolean {
  for (const v of values) {
    if (v.dataType !== oneType) {
      return false;
    }
  }
  return true;
}

function numeric(
  fs: FieldSpace,
  left: ExpressionDef,
  op: string,
  right: ExpressionDef
): ExprValue {
  const lhs = left.getExpression(fs);
  const rhs = right.getExpression(fs);

  const err = errorCascade('number', lhs, rhs);
  if (err) return err;

  const noGo = unsupportError(left, lhs, right, rhs);
  if (noGo) {
    return noGo;
  }
  const expressionType = maxExpressionType(
    lhs.expressionType,
    rhs.expressionType
  );

  if (allAre('number', lhs, rhs)) {
    return {
      dataType: 'number',
      expressionType,
      value: compose(lhs.value, op, rhs.value),
      evalSpace: mergeEvalSpaces(lhs.evalSpace, rhs.evalSpace),
    };
  }

  left.log(`Non numeric('${lhs.dataType},${rhs.dataType}') value with '${op}'`);
  return errorFor('numbers required');
}

function delta(
  fs: FieldSpace,
  left: ExpressionDef,
  op: string,
  right: ExpressionDef
): ExprValue {
  const lhs = left.getExpression(fs);
  const rhs = right.getExpression(fs);
  const noGo = unsupportError(left, lhs, right, rhs);
  if (noGo) {
    return noGo;
  }

  const timeLHS = isTimeFieldType(lhs.dataType);

  const err = errorCascade(timeLHS ? 'error' : 'number', lhs, rhs);
  if (err) return err;

  if (timeLHS) {
    let duration: ExpressionDef = right;
    if (rhs.dataType !== 'duration') {
      if (isGranularResult(lhs)) {
        duration = new ExprDuration(right, lhs.timeframe);
      } else if (lhs.dataType === 'date') {
        duration = new ExprDuration(right, 'day');
      } else {
        left.log(`Can not offset time by '${rhs.dataType}'`);
        return errorFor(`time plus ${rhs.dataType}`);
      }
    }
    return duration.apply(fs, op, left);
  }
  return numeric(fs, left, op, right);
}

/**
 * All of the magic of malloy expressions eventually flows to here,
 * where an operator is applied to two values. Depending on the
 * operator and value types this may involve transformations of
 * the values or even the operator.
 * @param fs FieldSpace for the symbols
 * @param left Left value
 * @param op The operator
 * @param right Right Value
 * @return ExprValue of the expression
 */
export function applyBinary(
  fs: FieldSpace,
  left: ExpressionDef,
  op: string,
  right: ExpressionDef
): ExprValue {
  if (isEquality(op)) {
    return equality(fs, left, op, right);
  }
  if (isComparison(op)) {
    return compare(fs, left, op, right);
  }
  if (oneOf(op, '+', '-')) {
    return delta(fs, left, op, right);
  }
  if (oneOf(op, '*', '%')) {
    return numeric(fs, left, op, right);
  }
  if (oneOf(op, '/')) {
    const num = left.getExpression(fs);
    const denom = right.getExpression(fs);
    const noGo = unsupportError(left, num, right, denom);
    if (noGo) {
      left.log('Cannot operate with unsupported type');
      return noGo;
    }

    const err = errorCascade('number', num, denom);
    if (err) return err;

    if (num.dataType !== 'number') {
      left.log('Numerator for division must be a number');
    } else if (denom.dataType !== 'number') {
      right.log('Denominator for division must be a number');
    } else {
      const div: DivFragment = {
        type: 'dialect',
        function: 'div',
        numerator: num.value,
        denominator: denom.value,
      };
      return {
        dataType: 'number',
        expressionType: maxExpressionType(
          num.expressionType,
          denom.expressionType
        ),
        evalSpace: mergeEvalSpaces(num.evalSpace, denom.evalSpace),
        value: [div],
      };
    }
    return errorFor('divide type mismatch');
  }
  left.log(`Cannot use ${op} operator here`);
  return errorFor('applybinary bad operator');
}

function errorCascade(dataType: ExpressionValueType, ...es: ExprValue[]) {
  if (es.some(e => e.dataType === 'error')) {
    return {
      dataType,
      expressionType: maxOfExpressionTypes(es.map(e => e.expressionType)),
      value: ["'cascading error'"],
      evalSpace: mergeEvalSpaces(...es.map(e => e.evalSpace)),
    };
  }
}

/**
 * Return an error if a binary operation includes unsupported types.
 */
function unsupportError(
  l: ExpressionDef,
  lhs: ExprValue,
  r: ExpressionDef,
  rhs: ExprValue
): ExprValue | undefined {
  const ret = {
    dataType: lhs.dataType,
    expressionType: maxExpressionType(lhs.expressionType, rhs.expressionType),
    value: ["'unsupported operation'"],
    evalSpace: mergeEvalSpaces(lhs.evalSpace, rhs.evalSpace),
  };
  if (lhs.dataType === 'unsupported') {
    l.log('Unsupported type not allowed in expression');
    return {...ret, dataType: rhs.dataType};
  }
  if (rhs.dataType === 'unsupported') {
    r.log('Unsupported type not allowed in expression');
    return ret;
  }
  return undefined;
}
