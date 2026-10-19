// A validator for the JSON Schema subset schemas/*.json use: type, enum,
// const, required, properties, additionalProperties, items, oneOf, anyOf,
// pattern, minimum and local "#" / "#/$defs/…" references. A keyword outside the
// subset throws, so a schema cannot quietly say more than it is checked for.
// (No ajv: it is not a dependency of this repo.)
type Schema = Record<string, unknown>;

const KNOWN = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "oneOf",
  "anyOf",
  "pattern",
  "minimum",
]);

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(want: string, v: unknown): boolean {
  const got = typeOf(v);
  return got === want || (want === "number" && got === "integer");
}

export function validate(schema: Schema, value: unknown): string[] {
  const errors: string[] = [];
  const walk = (s: Schema, v: unknown, at: string): void => {
    for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`unsupported keyword ${k}`);
    if (typeof s["$ref"] === "string") {
      const m = /^#\/\$defs\/(.+)$/.exec(s["$ref"]);
      const target =
        s["$ref"] === "#"
          ? schema
          : m
            ? (schema["$defs"] as Record<string, Schema> | undefined)?.[m[1]!]
            : undefined;
      if (!target) throw new Error(`unresolved ${s["$ref"]}`);
      walk(target, v, at);
      return;
    }
    if (s["const"] !== undefined && v !== s["const"])
      errors.push(`${at}: not ${JSON.stringify(s["const"])}`);
    if (Array.isArray(s["enum"]) && !s["enum"].includes(v)) errors.push(`${at}: not in enum`);
    if (s["type"] !== undefined) {
      const types = Array.isArray(s["type"]) ? (s["type"] as string[]) : [s["type"] as string];
      if (!types.some((t) => typeMatches(t, v))) {
        errors.push(`${at}: expected ${types.join("|")}, got ${typeOf(v)}`);
        return;
      }
    }
    if (
      typeof v === "string" &&
      typeof s["pattern"] === "string" &&
      !new RegExp(s["pattern"]).test(v)
    )
      errors.push(`${at}: does not match ${s["pattern"]}`);
    if (typeof v === "number" && typeof s["minimum"] === "number" && v < s["minimum"])
      errors.push(`${at}: below ${s["minimum"]}`);
    for (const key of ["oneOf", "anyOf"] as const) {
      const alts = s[key] as Schema[] | undefined;
      if (!alts) continue;
      const passing = alts.filter(
        (a) => validate({ ...a, $defs: schema["$defs"] }, v).length === 0,
      );
      if (key === "oneOf" ? passing.length !== 1 : passing.length === 0)
        errors.push(`${at}: matches ${passing.length} of the ${key} alternatives`);
    }
    if (Array.isArray(v) && s["items"])
      v.forEach((x, i) => walk(s["items"] as Schema, x, `${at}[${i}]`));
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      for (const r of (s["required"] as string[] | undefined) ?? [])
        if (!(r in o)) errors.push(`${at}: missing ${r}`);
      const props = (s["properties"] as Record<string, Schema> | undefined) ?? {};
      for (const [k, x] of Object.entries(o)) {
        if (props[k]) walk(props[k], x, `${at}.${k}`);
        else if (s["additionalProperties"] === false) errors.push(`${at}: unexpected ${k}`);
        else if (typeof s["additionalProperties"] === "object")
          walk(s["additionalProperties"] as Schema, x, `${at}.${k}`);
      }
    }
  };
  walk(schema, value, "$");
  return errors;
}
