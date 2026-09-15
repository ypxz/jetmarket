import { z } from "zod";
import type { AttributeSchema } from "@jetmarket/verticals";

export type AttrInputKind = "text" | "number" | "select" | "date";

/** Serializable form-field descriptor derived from an attribute's zod schema. */
export interface AttrInput {
  kind: AttrInputKind;
  required: boolean;
  options?: string[];
}

/** Attribute shape as served by /api/vertical (schema stripped, input added). */
export interface ClientAttribute {
  key: string;
  labelKey: string;
  appliesTo: string[];
  unitKey?: string;
  input: AttrInput;
}

const DATE_RE = /\\d\{4\}-\\d\{2\}-\\d\{2\}/;

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s = schema;
  for (;;) {
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) {
      s = s.unwrap();
    } else if (s instanceof z.ZodDefault) {
      s = s.removeDefault();
    } else if (s instanceof z.ZodEffects) {
      s = s.innerType();
    } else {
      return s;
    }
  }
}

/** zod schema -> { kind, options, required } for form rendering. */
export function attributeInput(attr: AttributeSchema): AttrInput {
  const s = unwrap(attr.schema);
  const required = attr.required ?? !attr.schema.isOptional();
  if (s instanceof z.ZodEnum) {
    return { kind: "select", options: s.options as string[], required };
  }
  if (s instanceof z.ZodNumber) return { kind: "number", required };
  if (s instanceof z.ZodString) {
    const isDate = (s._def.checks ?? []).some(
      (c) => c.kind === "regex" && DATE_RE.test(c.regex.source),
    );
    return { kind: isDate ? "date" : "text", required };
  }
  return { kind: "text", required };
}
