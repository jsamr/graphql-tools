import {
  GraphQLResolveInfo,
  getNullableType,
  isCompositeType,
  isListType,
  GraphQLError,
  GraphQLSchema,
  GraphQLCompositeType,
  isAbstractType,
  GraphQLList,
  GraphQLType,
  locatedError,
  GraphQLOutputType,
} from 'graphql';

import { AggregateError, Maybe } from '@graphql-tools/utils';

import { StitchingInfo, SubschemaConfig } from './types';
import { annotateExternalObject, isExternalObject, mergeFields } from './mergeFields';
import { Subschema } from './Subschema';

export function resolveExternalValue<TContext>(
  result: any,
  unpathedErrors: Array<GraphQLError>,
  subschema: GraphQLSchema | SubschemaConfig<any, any, any, TContext>,
  context?: Record<string, any>,
  info?: GraphQLResolveInfo,
  returnType = getReturnType(info),
  skipTypeMerging?: boolean
): any {
  const type = getNullableType(returnType);

  if (result instanceof Error) {
    return result;
  }

  if (result == null) {
    return reportUnpathedErrorsViaNull(unpathedErrors);
  }

  if ('parseValue' in type) {
    return type.parseValue(result);
  } else if (isCompositeType(type)) {
    return resolveExternalObject(type, result, unpathedErrors, subschema, context, info, skipTypeMerging);
  } else if (isListType(type)) {
    return resolveExternalList(type, result, unpathedErrors, subschema, context, info, skipTypeMerging);
  }
}

function resolveExternalObject<TContext>(
  type: GraphQLCompositeType,
  object: any,
  unpathedErrors: Array<GraphQLError>,
  subschema: GraphQLSchema | SubschemaConfig<any, any, any, TContext>,
  context?: Record<string, any>,
  info?: GraphQLResolveInfo,
  skipTypeMerging?: boolean
) {
  // if we have already resolved this object, for example, when the identical object appears twice
  // in a list, see https://github.com/ardatan/graphql-tools/issues/2304
  if (!isExternalObject(object)) {
    annotateExternalObject(object, unpathedErrors, subschema, Object.create(null));
  }

  if (skipTypeMerging || info == null) {
    return object;
  }

  const stitchingInfo = info.schema.extensions?.['stitchingInfo'] as Maybe<StitchingInfo>;

  if (stitchingInfo == null) {
    return object;
  }

  const typeName = isAbstractType(type) ? object.__typename : type.name;

  const mergedTypeInfo = stitchingInfo.mergedTypes[typeName];
  let targetSubschemas: undefined | Array<Subschema>;

  // Within the stitching context, delegation to a stitched GraphQLSchema or SubschemaConfig
  // will be redirected to the appropriate Subschema object, from which merge targets can be queried.
  if (mergedTypeInfo != null) {
    targetSubschemas = mergedTypeInfo.targetSubschemas.get(subschema as Subschema);
  }

  // If there are no merge targets from the subschema, return.
  if (!targetSubschemas || !targetSubschemas.length) {
    return object;
  }

  return mergeFields(mergedTypeInfo, object, subschema as Subschema, context, info);
}

function resolveExternalList<TContext>(
  type: GraphQLList<any>,
  list: Array<any>,
  unpathedErrors: Array<GraphQLError>,
  subschema: GraphQLSchema | SubschemaConfig<any, any, any, TContext>,
  context?: Record<string, any>,
  info?: GraphQLResolveInfo,
  skipTypeMerging?: boolean
) {
  return list.map(listMember =>
    resolveExternalListMember(
      getNullableType(type.ofType),
      listMember,
      unpathedErrors,
      subschema,
      context,
      info,
      skipTypeMerging
    )
  );
}

function resolveExternalListMember<TContext>(
  type: GraphQLType,
  listMember: any,
  unpathedErrors: Array<GraphQLError>,
  subschema: GraphQLSchema | SubschemaConfig<any, any, any, TContext>,
  context?: Record<string, any>,
  info?: GraphQLResolveInfo,
  skipTypeMerging?: boolean
): any {
  if (listMember instanceof Error) {
    return listMember;
  }

  if (listMember == null) {
    return reportUnpathedErrorsViaNull(unpathedErrors);
  }

  if ('parseValue' in type) {
    return type.parseValue(listMember);
  } else if (isCompositeType(type)) {
    return resolveExternalObject(type, listMember, unpathedErrors, subschema, context, info, skipTypeMerging);
  } else if (isListType(type)) {
    return resolveExternalList(type, listMember, unpathedErrors, subschema, context, info, skipTypeMerging);
  }
}

const reportedErrors = new WeakMap<GraphQLError, boolean>();

function reportUnpathedErrorsViaNull(unpathedErrors: Array<GraphQLError>) {
  if (unpathedErrors.length) {
    const unreportedErrors: Array<GraphQLError> = [];
    for (const error of unpathedErrors) {
      if (!reportedErrors.has(error)) {
        unreportedErrors.push(error);
        reportedErrors.set(error, true);
      }
    }

    if (unreportedErrors.length) {
      if (unreportedErrors.length === 1) {
        return unreportedErrors[0];
      }

      const combinedError = new AggregateError(
        unreportedErrors,
        unreportedErrors.map(error => error.message).join(', \n')
      );
      // We cast path as any for GraphQL.js 14 compat
      // locatedError path argument must be defined, but it is just forwarded to a constructor that allows a undefined value
      // https://github.com/graphql/graphql-js/blob/b4bff0ba9c15c9d7245dd68556e754c41f263289/src/error/locatedError.js#L25
      // https://github.com/graphql/graphql-js/blob/b4bff0ba9c15c9d7245dd68556e754c41f263289/src/error/GraphQLError.js#L19
      return locatedError(combinedError, undefined as any, unreportedErrors[0].path as any);
    }
  }

  return null;
}

function getReturnType(info: GraphQLResolveInfo | undefined): GraphQLOutputType {
  if (info == null) {
    throw new Error(`Return type cannot be inferred without a source schema.`);
  }
  return info.returnType;
}
