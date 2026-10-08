import { Component, computed, input, output } from '@angular/core';
import {
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
  type GraphQLArgument,
  type GraphQLEnumValue,
  type GraphQLField,
  type GraphQLInputField,
  type GraphQLNamedType,
  type GraphQLSchema,
} from 'graphql';

interface FieldRow {
  name: string;
  type: string;
  args: readonly GraphQLArgument[];
  description: string | null | undefined;
  deprecationReason: string | null | undefined;
}

function kindOf(type: GraphQLNamedType): string {
  if (isObjectType(type)) return 'type';
  if (isInterfaceType(type)) return 'interface';
  if (isUnionType(type)) return 'union';
  if (isEnumType(type)) return 'enum';
  if (isInputObjectType(type)) return 'input';
  return 'scalar';
}

function fieldRow(field: GraphQLField<unknown, unknown> | GraphQLInputField): FieldRow {
  return { name: field.name, type: field.type.toString(), args: 'args' in field ? field.args : [], description: field.description, deprecationReason: field.deprecationReason };
}

/** One type: its kind, description and interfaces, then its fields, enum values or members. Type names link to their own detail. */
@Component({
  selector: 'q-schema-type-detail',
  templateUrl: './schema-type-detail.html',
  host: { class: 'flex flex-col gap-3 text-xs', 'data-testid': 'graphql-type-detail' },
})
export class SchemaTypeDetail {
  readonly type = input.required<GraphQLNamedType>();
  readonly schema = input.required<GraphQLSchema>();
  readonly navigate = output<string>();

  protected readonly kind = computed(() => kindOf(this.type()));
  protected readonly fields = computed<FieldRow[]>(() => {
    const type = this.type();
    return isObjectType(type) || isInterfaceType(type) || isInputObjectType(type) ? Object.values(type.getFields()).map(fieldRow) : [];
  });
  protected readonly interfaces = computed(() => {
    const type = this.type();
    return isObjectType(type) || isInterfaceType(type) ? type.getInterfaces() : [];
  });
  protected readonly possible = computed(() => {
    const type = this.type();
    return isInterfaceType(type) || isUnionType(type) ? this.schema().getPossibleTypes(type) : [];
  });
  protected readonly values = computed<readonly GraphQLEnumValue[]>(() => {
    const type = this.type();
    return isEnumType(type) ? type.getValues() : [];
  });
  protected readonly isUnion = computed(() => isUnionType(this.type()));
  protected readonly specifiedBy = computed(() => {
    const type = this.type();
    return isScalarType(type) ? type.specifiedByURL : null;
  });
  protected readonly nothingMore = computed(() => !this.fields().length && !this.values().length && !this.possible().length && !isScalarType(this.type()));
  protected readonly namedType = computed(() => getNamedType(this.type()).name);

  /** Follow a type reference such as `[User!]!` to `User`. */
  protected follow(text: string): void {
    this.navigate.emit(text.replace(/[[\]!]/g, ''));
  }

  protected json(value: unknown): string {
    return JSON.stringify(value);
  }
}
