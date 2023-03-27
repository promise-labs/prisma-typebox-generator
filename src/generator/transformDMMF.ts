import type { DMMF } from '@prisma/generator-helper';

const transformField = (field: DMMF.Field) => {
  const tokens = [field.name + ':'];
  let inputTokens = [];
  const deps = new Set();

  if (['Int', 'Float', 'Decimal'].includes(field.type)) {
    tokens.push('Type.Number()');
  } else if (['BigInt'].includes(field.type)) {
    tokens.push('Type.Integer()');
  } else if (['String', 'DateTime', 'Date'].includes(field.type)) {
    tokens.push('Type.String()');
  } else if (['Json'].includes(field.type)) {
    tokens.push('Type.Object({}, {additionalProperties: true})');
  } else if (field.type === 'Boolean') {
    tokens.push('Type.Boolean()');
  } else {
    tokens.push(`::${field.type}::`);
    deps.add(field.type);
  }

  if (field.isList) {
    tokens.splice(1, 0, 'Type.Array(');
    tokens.splice(tokens.length, 0, ')');
  }

  inputTokens = [...tokens];

  // @id cannot be optional except for input if it's auto increment
  if (field.isId && (field?.default as any)?.name === 'autoincrement') {
    inputTokens.splice(1, 0, 'Type.Optional(');
    inputTokens.splice(inputTokens.length, 0, ')');
  }

  if ((!field.isRequired || field.hasDefaultValue) && !field.isId) {
    tokens.splice(1, 0, 'Type.Optional(');
    tokens.splice(tokens.length, 0, ')');
    inputTokens.splice(1, 0, 'Type.Optional(');
    inputTokens.splice(inputTokens.length, 0, ')');
  }

  return {
    str: tokens.join(' ').concat('\n'),
    strInput: inputTokens.join(' ').concat('\n'),
    deps,
  };
};

const transformFields = (fields: DMMF.Field[]) => {
  let dependencies = new Set();
  const _fields: string[] = [];
  const _inputFields: string[] = [];

  fields.map(transformField).forEach((field) => {
    _fields.push(field.str);
    _inputFields.push(field.strInput);
    [...field.deps].forEach((d) => {
      dependencies.add(d);
    });
  });

  return {
    dependencies,
    rawString: _fields.filter((f) => !!f).join(','),
    rawInputString: _inputFields.filter((f) => !!f).join(','),
  };
};

let depCount = 0;
const transformModel = (model: DMMF.Model, models?: DMMF.Model[]) => {
  depCount++;
  const fields = transformFields(model.fields);
  let raw = [
    `${models ? '' : `export const ${model.name} = `}Type.Object({\n\t`,
    fields.rawString,
    `}, {\n\t$id: \'#${!Array.isArray(models) || models.length === 0 ? model.name : `${model.name}_dep_${depCount}`}_model\', \n\tadditionalProperties: false\n})`,
  ].join('\n');
  let inputRaw = [
    `${models ? '' : `export const ${model.name}Input = `}Type.Object({\n\t`,
    fields.rawInputString,
    `}, {\n\t$id: \'#${!Array.isArray(models) || models.length === 0 ? model.name : `${model.name}_dep_${depCount}`}_input_model\', \n\tadditionalProperties: false\n})`,
  ].join('\n');

  if (Array.isArray(models)) {
    models.forEach((md) => {
      const re = new RegExp(`.+::${md.name}.+\n`, 'gm');
      const inputRe = new RegExp(`.+::${md.name}.+\n`, 'gm');
      raw = raw.replace(re, '');
      inputRaw = inputRaw.replace(inputRe, '');
    });
  }

  return {
    raw,
    inputRaw,
    deps: fields.dependencies,
  };
};

export const transformEnum = (enm: DMMF.DatamodelEnum) => {
  const values = enm.values
    .map((v) => `${v.name}: Type.Literal('${v.name}'),\n`)
    .join('');

  return [
    `const ${enm.name}Const = {`,
    values,
    '}\n',
    `export const ${enm.name} = Type.KeyOf(Type.Object(${enm.name}Const, { $id: '#${enm.name}', additionalProperties: false }))\n`,
    `export type ${enm.name}Type = Static<typeof ${enm.name}>`,
  ].join('\n');
};

export function transformDMMF(dmmf: DMMF.Document) {
  const { models, enums } = dmmf.datamodel;
  const importStatements = new Set([
    'import {Type, Static} from \'@sinclair/typebox\'',
  ]);

  return [
    ...models.map((model) => {
      let { raw, inputRaw, deps } = transformModel(model);

      [...deps].forEach((d) => {
        const depsModel = models.find((m) => m.name === d) as DMMF.Model;
        if (depsModel) {
          const output = transformModel(depsModel, models);
          let depRaw = output.raw;
          let depInputRaw = output.inputRaw;
          // Handle case where relation is first field in model
          const firstCommaIndex = depRaw.indexOf(",");
          if (firstCommaIndex !== -1 && firstCommaIndex < depRaw.indexOf(":")) {
            depRaw = depRaw.slice(0, firstCommaIndex) + depRaw.slice(firstCommaIndex + 1);
          }
          const firstCommaIndexInput = depInputRaw.indexOf(",");
          if (firstCommaIndexInput !== -1 && firstCommaIndexInput < depInputRaw.indexOf(":")) {
            depInputRaw = depInputRaw.slice(0, firstCommaIndexInput) + depInputRaw.slice(firstCommaIndexInput + 1);
          }

          const re = new RegExp(`::${d}::`, 'gm');
          raw = raw.replace(re, depRaw);
          inputRaw = inputRaw.replace(re, depInputRaw);
        }
      });

      enums.forEach((enm) => {
        const re = new RegExp(`::${enm.name}::`, 'gm');
        if (raw.match(re)) {
          raw = raw.replace(re, enm.name);
          inputRaw = inputRaw.replace(re, enm.name);
          importStatements.add(`import { ${enm.name} } from './${enm.name}'`);
        }
      });

      return {
        name: model.name,
        rawString: [
          [...importStatements].join('\n'),
          raw,
          `export type ${model.name}Type = Static<typeof ${model.name}>`,
        ].join('\n\n'),
        inputRawString: [
          [...importStatements].join('\n'),
          inputRaw,
          `export type ${model.name}InputType = Static<typeof ${model.name}Input>`,
        ].join('\n\n'),
      };
    }),
    ...enums.map((enm) => {
      return {
        name: enm.name,
        inputRawString: null,
        rawString:
          'import {Type, Static} from "@sinclair/typebox"\n\n' +
          transformEnum(enm),
      };
    }),
  ];
}
