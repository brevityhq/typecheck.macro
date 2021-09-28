const { createMacro, MacroError } = require('babel-plugin-macros')
const Ajv = require('ajv')
const ajv = new Ajv({ code: { source: true } })

const standaloneCode = require('ajv/dist/standalone')
const addFormats = require('ajv-formats')
const { _, nil } = Ajv

addFormats(ajv)

const classes = {
  buffer: _`global.Buffer`,
  regexp: _`RegExp`,
  function: _`Function`,
  date: _`Date`,
}

ajv.addKeyword({
  keyword: 'instanceof',
  code(context) {
    const { schema, parentSchema, data } = context
    const [, name, nullable] = schema.match(/^([a-z]+)(\?)?$/)
    const klass = classes[name]

    if (!klass) {
      throw new MacroError(`Invalid instanceof parameter '${schema}'`)
    }

    if (nullable && data == null) return true

    const nullCondition = nullable ? _`data == null || ` : nil
    context.fail(_`${nullCondition}!(${data} instanceof ${klass})`)
  },
})


function typeCheckMacro({ references, state, babel }) {
  const t = babel.types

  function compiledAst(valuesAst, schemaAst) {
    const schema = schemaAst.evaluate().value
    const parsed = parseSchema(schema)
    const compiled = compileSchema(parsed)


    const [
      , // use strict
      , // first export
      exports,
      ...compiledAst
    ] = babel.template.ast(compiled)

    const {
      expression: {
        right: schemaName,
      },
    } = exports

    return t.callExpression(
      t.identifier('__typeCheck'),
      [
        valuesAst.node,
        t.functionExpression(
          null,
          [t.identifier('schema')],
          t.blockStatement([
            ...compiledAst,
            babel.template.ast(`const parsed = ${JSON.stringify(parsed)}`),
            t.returnStatement(
              t.arrayExpression([
                t.callExpression(
                  schemaName,
                  [t.identifier('schema')],
                ),
                schemaName,
                t.identifier('parsed'),
              ])
            ),
          ])
        ),
      ],
    )
  }

    
  references.default.forEach(path => {
    const { parentPath } = path

    if (parentPath.type !== 'CallExpression') {
      throw new MacroError('typeCheck.macro is intended to be called like a function.')
    }

    const args = parentPath.get('arguments')
    const values = args[0]
    const schema = args[1]


    if (schema?.type !== 'ObjectExpression') {
      throw new MacroError('typeCheck.macro requires a schema as the first arugment.')
    }

    const ast = compiledAst(values, schema)
    parentPath.replaceWith(ast)
  })
}

module.exports = createMacro(typeCheckMacro)


function compileSchema(schema) {
  try {
    const validate = ajv.compile(schema)
    return standaloneCode(ajv, validate)

  } catch (e) {
    e.message = `Could not compile schema:\n\n${JSON.stringify(schema, null, 2)}\n\n${e.message}`
    throw e
  }
}

function parseSchema(schema) {
  try {
    return parseSchemaObjectType(schema)

  } catch (e) {
    e.message = `Could not parse schema:\n\n${JSON.stringify(schema, null, 2)}\n\n${e.message}`
    throw e
  }
}

function parseSchemaObjectType(schema) {
  const parentSchema = {
    type: 'object',
    properties: {},
  }

  Object.entries(schema).forEach(([key, value]) => {
    if (key.startsWith('$')) {
      const { childSchema } = parseSchemaType(value, true)
      parentSchema[key.slice(1)] = childSchema
      return
    }

    const { childSchema, isRequired } = parseSchemaType(value)

    parentSchema.properties[key] = childSchema

    if (isRequired) {
      parentSchema.required = parentSchema.required || []
      parentSchema.required.push(key)
    }
  })

  return parentSchema
}


function parseSchemaType(type, isInternal) {
  let isRequired = true
  let childSchema

  if (Array.isArray(type)) {
    const result = type.map(parseSchemaType)

    if (result.some(r => !r.isRequired)) {
      isRequired = false
    }

    childSchema = result.map(r => r.childSchema)

    if (!isInternal) {
      childSchema = { anyOf: childSchema }
    }

  } else {
    if (typeof type === 'string') {
      childSchema = parseSchemaStringType(type)
      isRequired = !type.endsWith('?')

    } else if (Object.isObject(type)) {
      childSchema = parseSchemaObjectType(type)
      isRequired = !childSchema.nullable

    } else {
      childSchema = type
      isRequired = !childSchema.nullable
    }
  }


  return {
    isRequired,
    childSchema,
  }
}

function parseSchemaStringType(unparsedType) {
  const parsed = {}

  let nullable = false
  let type = unparsedType

  if (type.endsWith('?')) {
    parsed.nullable = true
    type = type.slice(0, -1)
  }

  if (classes[type.toLowerCase()]) {
    return {
      instanceof: unparsedType.toLowerCase(),
    }
  }


  let requirePresence = false

  if (type.endsWith('!')) {
    requirePresence = true
    type = type.slice(0, -1)
  }

  if (type.endsWith('[]')) {
    type = type.slice(0, -2)

    const {
      childSchema,
    } = parseSchemaType(type)

    parsed.type = 'array'
    parsed.items = childSchema

    if (requirePresence) {
      parsed.minItems = 1
    }

  } else if (type === 'uuid') {
    parsed.type = 'string'
    parsed.format = 'uuid'

  } else if (type === 'false') {
    parsed.type = 'boolean'
    parsed.const = false

  } else if (type === 'true') {
    parsed.type = 'boolean'
    parsed.const = true

  } else if (type === 'string') {
    parsed.type = type
    
    if (requirePresence) {
      parsed.minLength = 1
    }

  } else if (type !== 'any') {
    parsed.type = type
  }

  return parsed
}
